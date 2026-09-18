import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserPreviewRequest } from "../shared/browser";
import { toolOutputText, type ProjectionEvent } from "./agent-projection";

const MIME: Record<string, string> = {
	".html": "text/html", ".htm": "text/html", ".css": "text/css",
	".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
	".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

function within(root: string, file: string): boolean {
	const path = relative(root, file);
	return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

/** Only explicit loopback URLs printed by a server command are candidates. */
export function localServerUrls(text: string): string[] {
	const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const urls = new Set<string>();
	for (const match of plain.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):\d{1,5}(?:\/[^\s<>"'`)]*)?/gi)) {
		try {
			const url = new URL(match[0]);
			if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
			if (url.hostname === "[::]") url.hostname = "[::1]";
			if (Number(url.port) > 0) urls.add(url.href);
		} catch { /* Invalid port or URL. */ }
	}
	return [...urls];
}

export function isServerCommand(command: string): boolean {
	if (/(?:^|[;&|\r\n])\s*Start-Process\s+(?:-FilePath\s+)?["']?(?:npm|pnpm|yarn|bun)(?:\.cmd)?["']?\s/i.test(command) &&
		/-ArgumentList\s+[^\r\n]*(?:\bdev\b|\bstart\b|\bserve\b|\bpreview\b)/i.test(command)) return true;
	// Match launching a server, not curl, a README read, or an echo containing a URL.
	return /(?:^|[;&|\r\n])\s*(?:nohup\s+)?((?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:(?:run|exec|x)\s+)?(?:dev|start|serve|preview)(?:[\s;&|"']|$)|(?:npx\s+)?(?:vite|next|nuxt|astro)\s*(?:dev|start|preview)?(?:[\s;&|"']|$)|(?:node|bun)\s+[^\s;]+\.(?:m?js|cjs)|python(?:3)?\s+-m\s+http\.server)/i.test(command);
}

/** One preview scope per live conversation, including its Fusion workers. */
export class BrowserPreview {
	private closed = false;
	private server?: Server;
	private origin?: Promise<string>;
	private calls = new Map<string, { name: string; args: Record<string, unknown>; output: string; seen: Set<string> }>();
	private probing = new Set<string>();
	private openedServers = new Set<string>();
	private abort = new AbortController();
	private htmlTimer?: ReturnType<typeof setTimeout>;
	private pendingHtml?: string;
	private startupPendingUntil = 0;
	constructor(private options: {
		cwd: string; sessionId: string; onPreview: (request: BrowserPreviewRequest) => void;
	}) {}

	handle(event: ProjectionEvent, source = "lead"): void {
		if (this.closed) return;
		if (event.type === "agent_end") { this.flushHtml(); return; }
		if (!("toolCallId" in event)) return;
		const key = `${source}:${event.toolCallId}`;
		if (event.type === "tool_execution_start") {
			this.calls.set(key, { name: event.toolName, args: (event.args ?? {}) as Record<string, unknown>, output: "", seen: new Set() });
			if (["bash", "powershell"].includes(event.toolName) && isServerCommand(String((event.args as { command?: unknown })?.command ?? "")))
				this.startupPendingUntil = Date.now() + 120_000;
			return;
		}
		const call = this.calls.get(key);
		if (!call) return;
		if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
			if (["bash", "powershell"].includes(call.name) &&
				(isServerCommand(String(call.args.command ?? "")) ||
					(this.startupPendingUntil > Date.now() && /\b(?:Get-Content|cat|tail)\b[^\r\n]*\.log\b/i.test(String(call.args.command ?? ""))))) {
				call.output = (call.output + "\n" + toolOutputText(result)).slice(-64000);
				for (const url of localServerUrls(call.output)) {
					if (call.seen.has(url)) continue;
					call.seen.add(url);
					void this.openServer(url);
				}
			}
			if (event.type === "tool_execution_end") {
				this.calls.delete(key);
				if (!event.isError && ["write", "edit"].includes(call.name) &&
					typeof call.args.path === "string" && /\.html?$/i.test(call.args.path)) {
					this.pendingHtml = call.args.path;
					clearTimeout(this.htmlTimer);
					this.htmlTimer = setTimeout(() => this.flushHtml(), 600);
				}
			}
		}
	}

	private flushHtml(): void {
		clearTimeout(this.htmlTimer);
		const path = this.pendingHtml;
		this.pendingHtml = undefined;
		if (path) void this.openHtml(path).catch(() => { /* Deleted or not a standalone page. */ });
	}

	private async openServer(url: string): Promise<void> {
		if (this.probing.has(url) || this.openedServers.has(url)) return;
		this.probing.add(url);
		try {
			// Startup logs can precede the listener. Never guess a port or start a server.
			for (let attempt = 0; attempt < 8 && !this.closed; attempt++) {
				try {
					const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(1200)]) });
					await response.body?.cancel();
					if (response.status >= 200 && response.status < 400) {
						if (this.closed) return;
						this.openedServers.add(url);
						this.emit(url, "server");
						return;
					}
				} catch { /* Still starting or stopped. */ }
				await new Promise<void>((done) => {
					const timer = setTimeout(finish, 400);
					const signal = this.abort.signal;
					function finish() { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); }
					signal.addEventListener("abort", finish, { once: true });
					if (signal.aborted) finish();
				});
			}
		} finally { this.probing.delete(url); }
	}

	private async openHtml(path: string): Promise<void> {
		if (this.closed) return;
		const root = await realpath(this.options.cwd);
		const target = await realpath(resolve(root, path));
		if (!within(root, target) || !(await stat(target)).isFile()) return;
		// A framework entry such as Vite's index.html needs its dev server.
		for (let dir = dirname(target); within(root, dir); dir = dirname(dir)) {
			try {
				const pkg = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8"));
				const deps = { ...pkg.dependencies, ...pkg.devDependencies };
				if (["vite", "next", "nuxt", "@vue/cli-service", "@angular/core", "astro"].some((key) => key in deps)) return;
			} catch { /* No package at this level. */ }
			if (dir === root) break;
		}
		if (this.closed) return;
		const origin = await (this.origin ??= this.serve(root));
		if (this.closed) return;
		const url = origin + "/" + relative(root, target).split(sep).map(encodeURIComponent).join("/");
		this.emit(url, "html");
	}

	private emit(url: string, kind: BrowserPreviewRequest["kind"]): void {
		if (!this.closed) this.options.onPreview({ id: randomUUID(), sessionId: this.options.sessionId, cwd: this.options.cwd, url, kind });
	}

	private async serve(root: string): Promise<string> {
		const server = createServer((req, res) => {
			void (async () => {
				const address = server.address();
				if (!address || typeof address === "string" || req.headers.host !== `127.0.0.1:${address.port}`) {
					res.writeHead(403).end(); return;
				}
				if (!["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(405).end(); return; }
				const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
				const parts = pathname.replace(/\\/g, "/").split("/").filter(Boolean);
				if (parts.some((part) => part.startsWith("."))) { res.writeHead(403).end(); return; }
				let target = await realpath(resolve(root, ...parts));
				if (!within(root, target)) { res.writeHead(403).end(); return; }
				if ((await stat(target)).isDirectory()) target = await realpath(resolve(target, "index.html"));
				const type = MIME[extname(target).toLowerCase()];
				if (!within(root, target) || !type || !(await stat(target)).isFile()) { res.writeHead(403).end(); return; }
				res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
				if (req.method === "HEAD") res.end();
				else createReadStream(target).on("error", () => res.destroy()).pipe(res);
			})().catch(() => { if (!res.headersSent) res.writeHead(404); res.end(); });
		});
		this.server = server;
		return new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				if (this.closed) { server.close(); reject(new Error("Preview closed")); return; }
				const address = server.address();
				if (!address || typeof address === "string") { reject(new Error("No preview address")); return; }
				done(`http://127.0.0.1:${address.port}`);
			});
		});
	}

	dispose(): void {
		this.closed = true;
		this.abort.abort();
		clearTimeout(this.htmlTimer);
		this.calls.clear();
		this.server?.closeAllConnections();
		this.server?.close();
	}
}
