import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeNekoShellEnvironment } from "./shell-environment";

/**
 * Dev servers the clone workflow starts and stops.
 *
 * The agent's shell tool waits for its command to exit and has no default
 * timeout, so `npm run dev` run through it never returns: the run hangs until
 * the user presses stop, and the URL the server printed is never seen. A server
 * started here runs beside the agent instead, reports the address it actually
 * bound, and keeps its recent output for the compile errors QA needs to read.
 */

const LOG_LINES = 200;
const STATUS_LOG_LINES = 40;
const START_TIMEOUT_MS = 120_000;
/** After the address is printed, how long to wait for the "ready" line. */
const READY_GRACE_MS = 15_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/i;
const READY = /\bready\b/i;

export interface DevServerStatus {
	directory: string;
	running: boolean;
	url?: string;
	command?: string;
	exitCode?: number | null;
	/** The most recent output lines, oldest first. */
	log: string;
}

/**
 * The command that runs a project's `dev` script with the package manager its
 * lockfile names. Bun is told `--bun` so the script runs on Bun's own runtime
 * rather than whatever `node` is first on PATH.
 */
export function devServerCommand(root: string, port?: number): string {
	let scripts: Record<string, unknown> | undefined;
	try {
		scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> })
			.scripts;
	} catch {
		throw new Error("No readable package.json in " + root);
	}
	if (typeof scripts?.dev !== "string") throw new Error("package.json has no dev script in " + root);
	const has = (file: string) => existsSync(join(root, file));
	const portArgs = port ? ` --port ${port}` : "";
	if (has("package-lock.json")) return `npm run dev --${portArgs}`;
	if (has("bun.lock") || has("bun.lockb")) return `bun --bun run dev${portArgs}`;
	if (has("pnpm-lock.yaml")) return `pnpm run dev${portArgs}`;
	if (has("yarn.lock")) return `yarn run dev${portArgs}`;
	return `npm run dev --${portArgs}`;
}

/** Kill the server and everything it started — `npm` runs `next` as a grandchild. */
function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", () => child.kill());
		return;
	}
	try {
		// Started detached, so the server leads its own process group.
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

class DevServer {
	readonly lines: string[] = [];
	url?: string;
	ready = false;
	exitCode?: number | null;
	private partial = "";
	private listeners = new Set<() => void>();

	constructor(
		readonly directory: string,
		readonly command: string,
		readonly child: ChildProcess,
	) {
		const onData = (chunk: Buffer | string) => this.append(chunk.toString());
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("exit", (code) => {
			this.flush();
			this.exitCode = code;
			this.changed();
		});
		child.on("error", (error) => {
			this.lines.push(`[failed to start] ${error.message}`);
			this.exitCode ??= -1;
			this.changed();
		});
	}

	get running(): boolean {
		return this.exitCode === undefined;
	}

	private append(text: string): void {
		const parts = (this.partial + text.replace(ANSI, "")).split(/\r?\n/);
		this.partial = parts.pop() ?? "";
		for (const line of parts) this.line(line);
		this.changed();
	}

	private flush(): void {
		if (this.partial) this.line(this.partial);
		this.partial = "";
	}

	private line(line: string): void {
		this.lines.push(line);
		if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
		const url = this.url ? undefined : line.match(LOCAL_URL)?.[0];
		// A server listening on every interface is reached through localhost.
		if (url) this.url = url.replace("0.0.0.0", "localhost").replace(/\/$/, "");
		if (READY.test(line)) this.ready = true;
	}

	private changed(): void {
		for (const listener of [...this.listeners]) listener();
	}

	/** Resolve once the server has an address and has said it is ready, or has exited. */
	waitUntilStarted(signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error?: Error) => {
				clearTimeout(timeout);
				clearTimeout(graceTimer);
				this.listeners.delete(check);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const check = () => {
				if (!this.running) return finish();
				if (this.url && this.ready) return finish();
				if (this.url && !graceTimer) graceTimer = setTimeout(() => finish(), READY_GRACE_MS);
			};
			const onAbort = () => finish(new Error("Tool call cancelled"));
			const timeout = setTimeout(
				() => finish(new Error(`The dev server printed no local URL within ${START_TIMEOUT_MS / 1000}s`)),
				START_TIMEOUT_MS,
			);
			this.listeners.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	status(lines = STATUS_LOG_LINES): DevServerStatus {
		return {
			directory: this.directory,
			running: this.running,
			url: this.url,
			command: this.command,
			exitCode: this.exitCode,
			log: this.lines.slice(-lines).join("\n"),
		};
	}
}

export class DevServerRegistry {
	/** By absolute project root: one server per project, whoever asked for it. */
	private servers = new Map<string, DevServer>();

	constructor(
		private readonly options: {
			commandFor?: (root: string, port?: number) => string;
		} = {},
	) {}

	async start(
		root: string,
		directory: string,
		options: { port?: number; signal?: AbortSignal } = {},
	): Promise<DevServerStatus> {
		const existing = this.servers.get(root);
		if (existing?.running) {
			if (!existing.url) await existing.waitUntilStarted(options.signal);
			return existing.status();
		}
		const command = (this.options.commandFor ?? devServerCommand)(root, options.port);
		const { env } = sanitizeNekoShellEnvironment({ command, cwd: root, env: { ...process.env } });
		const child = spawn(command, {
			cwd: root,
			env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		const server = new DevServer(directory, command, child);
		this.servers.set(root, server);
		try {
			await server.waitUntilStarted(options.signal);
		} catch (error) {
			killTree(child);
			throw error;
		}
		if (!server.running) {
			this.servers.delete(root);
			const status = server.status();
			throw new Error(`The dev server exited with code ${status.exitCode} before it was ready:\n${status.log}`);
		}
		return server.status();
	}

	status(root: string, directory: string): DevServerStatus {
		return this.servers.get(root)?.status() ?? { directory, running: false, log: "" };
	}

	stop(root: string, directory: string): DevServerStatus {
		const server = this.servers.get(root);
		if (!server) return { directory, running: false, log: "" };
		this.servers.delete(root);
		killTree(server.child);
		return { ...server.status(), running: false };
	}

	stopAll(): void {
		for (const server of this.servers.values()) killTree(server.child);
		this.servers.clear();
	}
}

/** App-wide: a server outlives the session that started it until stopped or the app quits. */
export const devServers = new DevServerRegistry();
