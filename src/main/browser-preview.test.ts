import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserPreview, isServerCommand, localServerUrls } from "./browser-preview";
import { workflowSandbox, waitFor } from "./workflow-test-utils";
import type { BrowserPreviewRequest } from "../shared/browser";

function fixture() {
	const sandbox = workflowSandbox();
	const previews: BrowserPreviewRequest[] = [];
	const preview = new BrowserPreview({ cwd: sandbox.cwd, sessionId: "current-session", onPreview: (request) => previews.push(request) });
	return { ...sandbox, previews, preview, cleanup: () => { preview.dispose(); sandbox.cleanup(); } };
}
function edit(f: ReturnType<typeof fixture>, path: string, isError = false, source = "lead") {
	f.preview.handle({ type: "tool_execution_start", toolCallId: "edit", toolName: "write", args: { path } }, source);
	f.preview.handle({ type: "tool_execution_end", toolCallId: "edit", toolName: "write", result: {}, isError }, source);
	f.preview.handle({ type: "agent_end" }, source);
}
function output(f: ReturnType<typeof fixture>, command: string, text: string) {
	f.preview.handle({ type: "tool_execution_start", toolCallId: "shell", toolName: "powershell", args: { command } });
	f.preview.handle({ type: "tool_execution_update", toolCallId: "shell", toolName: "powershell", args: {}, partialResult: { content: [{ type: "text", text }] } });
}

describe("browser automatic previews", () => {
	test("normalizes only loopback endpoints and recognizes development commands", () => {
		expect(localServerUrls("\x1b[32mLocal: http://0.0.0.0:5173/demo\x1b[0m\nhttp://192.168.1.2:5173 https://example.com:123 http://localhost:99999")).toEqual(["http://127.0.0.1:5173/demo"]);
		for (const command of ["npm run dev -- --port 3001", "pnpm dev", "bun run start", "npx next dev", "cd app; npm.cmd run dev", "Start-Process npm -ArgumentList 'run dev'"]) {
			expect(isServerCommand(command)).toBe(true);
		}
		expect(isServerCommand("curl http://localhost:3000")).toBe(false);
		expect(isServerCommand("Get-Content README.md")).toBe(false);
		expect(isServerCommand("echo npm run dev http://localhost:3000")).toBe(false);
	});

	test("successful HTML edits from a worker serve the page and relative assets, then refresh", async () => {
		const f = fixture();
		try {
			mkdirSync(join(f.cwd, "pages"));
			writeFileSync(join(f.cwd, "pages", "hello world.html"), '<link rel="stylesheet" href="../style.css"><h1>Hello</h1>');
			writeFileSync(join(f.cwd, "style.css"), "h1 { color: red }");
			writeFileSync(join(f.cwd, ".env"), "SECRET");
			edit(f, "pages/hello world.html", false, "worker-1");
			await waitFor(() => f.previews.length === 1);
			const request = f.previews[0];
			expect(request.kind).toBe("html");
			expect(request.sessionId).toBe("current-session");
			expect(await (await fetch(request.url)).text()).toContain("<h1>Hello</h1>");
			expect((await fetch(new URL("../style.css", request.url))).headers.get("content-type")).toBe("text/css");
			expect((await fetch(new URL("/.env", request.url))).status).toBe(403);
			expect((await fetch(request.url, { method: "POST" })).status).toBe(405);
			writeFileSync(join(f.cwd, "pages", "hello world.html"), "Updated");
			edit(f, "pages/hello world.html");
			await waitFor(() => f.previews.length === 2);
			expect(f.previews[1].url).toBe(request.url);
			expect(f.previews[1].id).not.toBe(request.id);
			expect(await (await fetch(request.url)).text()).toBe("Updated");
		} finally { f.cleanup(); }
	});

	test("failed edits, out-of-project paths, and framework templates do not open raw HTML", async () => {
		const f = fixture();
		try {
			writeFileSync(join(f.cwd, "index.html"), "template");
			writeFileSync(join(f.root, "outside.html"), "outside");
			edit(f, "index.html", true);
			edit(f, "../outside.html");
			writeFileSync(join(f.cwd, "package.json"), JSON.stringify({ devDependencies: { vite: "1" } }));
			edit(f, "index.html");
			await Bun.sleep(150);
			expect(f.previews).toEqual([]);
		} finally { f.cleanup(); }
	});

	test("a real startup URL opens during streaming, only once, and not from ordinary output", async () => {
		const f = fixture();
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Running") });
		const url = `http://127.0.0.1:${server.port}/`;
		try {
			output(f, "Get-Content README.md", url);
			await Bun.sleep(50);
			expect(f.previews).toHaveLength(0);
			output(f, "npm run dev", "Local: " + url);
			await waitFor(() => f.previews.length === 1);
			expect(f.previews[0].kind).toBe("server");
			output(f, "npm run dev", "Local: " + url);
			await Bun.sleep(50);
			expect(f.previews).toHaveLength(1);
		} finally { f.cleanup(); server.stop(true); }
	});

	test("a detached server's log is recognized only after a launch in this session", async () => {
		const f = fixture();
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ready") });
		const url = `http://127.0.0.1:${server.port}/`;
		try {
			output(f, "Get-Content dev.log", url);
			await Bun.sleep(40);
			expect(f.previews).toHaveLength(0);
			output(f, "Start-Process npm.cmd -ArgumentList 'run dev' -RedirectStandardOutput dev.log", "");
			output(f, "Get-Content dev.log", url);
			await waitFor(() => f.previews.length === 1);
		} finally { f.cleanup(); server.stop(true); }
	});

	test("waits for readiness and discards late notifications after switching sessions", async () => {
		const f = fixture();
		let ready = false;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Starting", { status: ready ? 200 : 503 }) });
		try {
			output(f, "pnpm dev", `http://127.0.0.1:${server.port}`);
			await Bun.sleep(80);
			expect(f.previews).toHaveLength(0);
			ready = true;
			await waitFor(() => f.previews.length === 1);
			writeFileSync(join(f.cwd, "index.html"), "Hello");
			edit(f, "index.html");
			f.preview.dispose();
			await Bun.sleep(80);
			expect(f.previews).toHaveLength(1);
		} finally { f.cleanup(); server.stop(true); }
	});
});
