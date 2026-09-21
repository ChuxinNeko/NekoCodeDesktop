import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskManager } from "./task-manager";
import { LanService } from "./lan-service";
import { encodeLanPairing, parseLanPairing } from "../shared/lan-pairing";

const fixtures: Array<{ service: LanService; dir: string }> = [];
afterEach(async () => { for (const { service, dir } of fixtures.splice(0)) { await service.stop(); rmSync(dir, { recursive: true, force: true }); } });

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-lan-test-"));
	let created = 0; let aborted = 0;
	const changes: unknown[] = [];
	const tasks = {
		list: async () => [{ id: "desktop-task", title: "Desktop", cwd: dir, sessionFile: "/private/transcript.jsonl", running: true }],
		create: async (_cwd: string, select: boolean) => {
			expect(select).toBe(false); created++;
			await new Promise((resolve) => setTimeout(resolve, 15));
			return { getSnapshot: () => ({ session: { id: "phone-task" } }), send: async () => ({ accepted: true }) };
		},
		byId: async () => ({ getSnapshot: () => ({ session: { id: "desktop-task", sessionFile: "secret" } }), abort: async () => { aborted++; },
			setMode: (mode: string) => changes.push(mode), setWorkMode: (mode: string) => changes.push(mode),
			setModel: async (model: string) => { changes.push(model); }, setThinkingLevel: async (level: string) => { changes.push(level); },
			send: async (prompt: { text: string }) => { changes.push(prompt.text); return { accepted: true }; },
			slashCommands: async () => [{ name: "help" }, { name: "terminal" }],
		}),
	} as unknown as TaskManager;
	const service = new LanService(dir, tasks);
	fixtures.push({ service, dir });
	// Fixed loopback URL is only used by tests; production advertises LAN addresses.
	await service.start(0);
	const server = (service as unknown as { server: { address(): { port: number } } }).server;
	const url = `http://127.0.0.1:${server.address().port}`;
	const request = (path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) => fetch(url + path, {
		method: body === undefined ? "GET" : "POST",
		headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const pair = async () => {
		const response = await request("/api/pair", { code: service.status().pairing!.code, name: "Test phone" });
		expect(response.status).toBe(200); return (await response.json()).token as string;
	};
	return { service, request, pair, dir, tasks, changes, created: () => created, aborted: () => aborted };
}

describe("LAN authentication and task API", () => {
	test("regenerating the desktop QR invalidates the old code and scanning consumes the new code", async () => {
		const f = await setup();
		const old = parseLanPairing(encodeLanPairing("192.168.1.8", f.service.status().pairing!));
		const next = parseLanPairing(encodeLanPairing("192.168.1.8", f.service.newPairing().pairing!));
		expect((await f.request("/api/pair", { code: old.code, name: "Scanned phone" })).status).toBe(403);
		expect((await f.request("/api/pair", { code: next.code, name: "Scanned phone" })).status).toBe(200);
		expect(f.service.status().pairing).toBeNull();
		expect((await f.request("/api/pair", { code: next.code })).status).toBe(403);
	});
	test("native app settings and follow-up messages address the specified task and validate options", async () => {
		const f = await setup(); const token = await f.pair();
		const configure = "/api/tasks/desktop-task/configure";
		expect((await f.request(configure, { mode: "invalid" }, token)).status).toBe(400);
		expect((await f.request(configure, { workMode: "invalid" }, token)).status).toBe(400);
		expect((await f.request(configure, { thinkingLevel: "invalid" }, token)).status).toBe(400);
		expect(f.changes).toHaveLength(0);
		expect((await f.request(configure, { mode: "read-only", modelKey: "provider/model" }, token)).status).toBe(200);
		expect(f.changes).toEqual(["read-only", "provider/model"]);
		const body = { text: "Continue this task", requestId: "followup-message-1234" };
		await Promise.all([f.request("/api/tasks/desktop-task/send", body, token), f.request("/api/tasks/desktop-task/send", body, token)]);
		expect(f.changes.filter((value) => value === body.text)).toHaveLength(1);
		const commands = await (await f.request("/api/tasks/desktop-task/commands", undefined, token)).json();
		expect(commands).toEqual([{ name: "help" }]);
		expect((await f.request("/", undefined, token)).status).toBe(404);
	});
	test("requires pairing, rejects hostile origins/hosts, stores only token hashes and revokes immediately", async () => {
		const f = await setup();
		expect((await f.request("/api/state")).status).toBe(401);
		expect((await f.request("/api/pair", { code: "错误错误错误错误错误" })).status).toBe(403);
		const code = f.service.status().pairing!.code;
		const token = await f.pair();
		expect((await f.request("/api/pair", { code })).status).toBe(403);
		expect((await f.request("/api/state", undefined, token, { Origin: "https://evil.example" })).status).toBe(403);
		expect((await f.request("/api/state", undefined, token, { Host: "evil.example" })).status).toBe(403);
		const state = await (await f.request("/api/state", undefined, token)).json();
		expect(state.tasks).toHaveLength(1); expect(state.tasks[0].sessionFile).toBeUndefined();
		expect(readFileSync(join(f.dir, "lan-devices.json"), "utf8")).not.toContain(token);
		f.service.revoke(f.service.status().devices[0].id);
		expect((await f.request("/api/state", undefined, token)).status).toBe(401);
	});

	test("validates project access and deduplicates simultaneous mobile requests", async () => {
		const f = await setup(); const token = await f.pair();
		const project = f.service.addProject(f.dir).projects[0];
		const body = { projectId: project.id, text: "Build a page", requestId: "mobile-request-12345" };
		expect((await f.request("/api/tasks", { ...body, projectId: "unknown" }, token)).status).toBe(403);
		expect((await f.request("/api/tasks", { ...body, text: "/new" }, token)).status).toBe(400);
		const responses = await Promise.all([f.request("/api/tasks", body, token), f.request("/api/tasks", body, token)]);
		const results = await Promise.all(responses.map((r) => r.json()));
		expect(results[0]).toEqual({ id: "phone-task", accepted: true }); expect(results[1]).toEqual(results[0]); expect(f.created()).toBe(1);
		expect((await f.request("/api/tasks", { ...body, text: "Different task" }, token)).status).toBe(409);
		await f.request("/api/tasks/desktop-task/abort", {}, token); expect(f.aborted()).toBe(1);
		f.service.removeProject(project.id);
		expect((await f.request("/api/tasks", { ...body, requestId: "another-request-12345" }, token)).status).toBe(403);
	});

	test("limits pairing guesses, serves only the native client API, and starts disabled after restart", async () => {
		const f = await setup(); const token = await f.pair();
		const response = await f.request("/api/info"); expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		f.service.newPairing();
		for (let i = 0; i < 9; i++) await f.request("/api/pair", { code: "0000000000" });
		expect((await f.request("/api/pair", { code: f.service.status().pairing!.code })).status).toBe(429);
		await f.service.stop();
		const restarted = new LanService(f.dir, f.tasks);
		expect(restarted.status().enabled).toBe(false);
		expect(restarted.status().devices).toHaveLength(1);
		expect(JSON.stringify(restarted.status())).not.toContain(token);
	});

	test("rejects oversized bodies and cross-site form submissions", async () => {
		const f = await setup(); const token = await f.pair();
		expect((await f.request("/api/tasks", { text: "x".repeat(70_000) }, token)).status).toBe(413);
		expect((await f.request("/api/tasks", {}, token, { "Content-Type": "text/plain" })).status).toBe(415);
	});
});
