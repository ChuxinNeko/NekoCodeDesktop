import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskManager } from "./task-manager";
import { LanService } from "./lan-service";
import { encodeLanPairing, parseLanPairing } from "../shared/lan-pairing";
import type { AgentCell, AgentSnapshot } from "../shared/agent";
import { applySnapshotDelta, SnapshotDeltaCache, type AgentSnapshotDelta } from "../shared/agent-delta";
import { remoteToolOutput, remoteView, type RemoteViewRequest } from "./agent-remote-view";

const fixtures: Array<{ service: LanService; dir: string }> = [];
afterEach(async () => { for (const { service, dir } of fixtures.splice(0)) { await service.stop(); rmSync(dir, { recursive: true, force: true }); } });

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-lan-test-"));
	let created = 0; let aborted = 0;
	const changes: unknown[] = [];
	// A stand-in transcript the delta route can be driven over, backed by the real
	// cache so the test covers the wiring rather than a re-implementation of it.
	const deltaCache = new SnapshotDeltaCache("test");
	const transcript: AgentCell[] = [{ id: "c1", type: "user", text: "hi", timestamp: 1 }];
	const stubSnapshot = () => ({
		session: { id: "desktop-task", sessionFile: "/private/transcript.jsonl" },
		cells: [...transcript], models: [], checkpoints: [],
	}) as unknown as AgentSnapshot;
	const toolOutput = (toolCallId: string, offset: number) => remoteToolOutput(stubSnapshot(), toolCallId, offset);
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
			toolOutput,
			snapshotDelta: (request: RemoteViewRequest & { since?: string } = {}) => {
				const view = remoteView(stubSnapshot(), request);
				return { ...deltaCache.next(view.snapshot, request.since), more: view.more };
			},
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
	const appendCell = (cell: AgentCell) => transcript.push(cell);
	return { service, request, pair, dir, tasks, changes, appendCell, created: () => created, aborted: () => aborted };
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

describe("relay dispatch", () => {
	const PEER = "peer-mobile-123456";
	const ID = "relay-request-12345";

	test("serves /api/state while the LAN server is off, with no pairing or token, and still strips sessionFile", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nekocode-lan-test-"));
		const tasks = {
			list: async () => [{ id: "desktop-task", title: "Desktop", cwd: dir, sessionFile: "/private/transcript.jsonl", running: true }],
		} as unknown as TaskManager;
		const service = new LanService(dir, tasks);
		fixtures.push({ service, dir });
		expect(service.status().enabled).toBe(false);
		const response = await service.handleRelay(PEER, { id: ID, method: "GET", path: "/api/state" });
		expect(response.id).toBe(ID);
		expect(response.status).toBe(200);
		const body = response.body as { tasks: Array<{ sessionFile?: string }> };
		expect(body.tasks).toHaveLength(1);
		expect(body.tasks[0].sessionFile).toBeUndefined();
	});

	test("task creation keeps project authorization, option validation and per-peer dedupe", async () => {
		const f = await setup();
		const project = f.service.addProject(f.dir).projects[0];
		const body = { projectId: project.id, text: "Build a page", requestId: "mobile-request-12345" };
		const create = (peer: string, payload: unknown) =>
			f.service.handleRelay(peer, { id: ID, method: "POST", path: "/api/tasks", body: payload as Record<string, unknown> });

		expect((await create(PEER, { ...body, projectId: "unknown" })).status).toBe(403);
		expect((await create(PEER, { ...body, requestId: "opt-check-1234567", options: { mode: "invalid" } })).status).toBe(400);

		const [first, second] = await Promise.all([create(PEER, body), create(PEER, body)]);
		expect(first.status).toBe(200);
		expect(second.body).toEqual(first.body);
		expect(f.created()).toBe(1);

		const other = await create("peer-mobile-654321", body);
		expect(other.status).toBe(200);
		expect(f.created()).toBe(2);
	});

	test("rejects malformed envelopes with 400 and unknown paths with 404", async () => {
		const f = await setup();
		const relay = (request: Record<string, unknown>, peer = PEER) => f.service.handleRelay(peer, request as never);
		expect((await relay({ id: ID, method: "PUT", path: "/api/state" })).status).toBe(400);
		expect((await relay({ id: ID, method: "GET", path: "/state" })).status).toBe(400);
		expect((await relay({ id: ID, method: "GET", path: "/api/state?x=1" })).status).toBe(400);
		expect((await relay({ id: ID, method: "GET", path: "/api/state#frag" })).status).toBe(400);
		expect((await relay({ id: ID, method: "GET", path: "/api/state", body: {} })).status).toBe(400);
		expect((await relay({ id: ID, method: "POST", path: "/api/tasks", body: [1, 2] })).status).toBe(400);
		expect((await relay({ id: ID, method: "POST", path: "/api/tasks" })).status).toBe(400);
		expect((await relay({ id: "short", method: "GET", path: "/api/state" })).status).toBe(400);
		expect((await relay({ id: ID, method: "GET", path: "/api/state" }, "bad peer!")).status).toBe(400);
		const missing = await relay({ id: ID, method: "GET", path: "/api/nope" });
		expect(missing.status).toBe(404);
		expect(missing.id).toBe(ID);
	});

	test("the delta route sends the transcript once, then only what changed", async () => {
		const f = await setup();
		const delta = async (since?: string) => {
			const response = await f.service.handleRelay(PEER, {
				id: ID, method: "POST", path: "/api/tasks/desktop-task/delta",
				body: since === undefined ? {} : { since },
			});
			expect(response.status).toBe(200);
			return response.body as AgentSnapshotDelta;
		};

		const first = await delta();
		expect(first.full).toBeDefined();
		expect(first.full?.cells).toHaveLength(1);
		// A path on the desktop's disk, which is not the phone's business.
		expect(first.full?.session.sessionFile).toBeUndefined();

		f.appendCell({ id: "c2", type: "user", text: "and again", timestamp: 2 });
		const second = await delta(first.version);
		expect(second.full).toBeUndefined();
		expect(second.cells?.map((cell) => cell.id)).toEqual(["c2"]);
		expect(second.order).toEqual(["c1", "c2"]);
		expect((second.rest?.session as { sessionFile?: string } | undefined)?.sessionFile).toBeUndefined();

		// Applying it to what the client already holds reproduces the transcript.
		const applied = applySnapshotDelta(first.full!, second);
		expect(applied?.cells.map((cell) => cell.id)).toEqual(["c1", "c2"]);

		// Nothing moved since, so the next poll carries no cells at all.
		const third = await delta(second.version);
		expect(third.full).toBeUndefined();
		expect(third.cells).toBeUndefined();
		expect(third.order).toBeUndefined();
	});

	test("an unrecognized delta version falls back to a full transcript", async () => {
		const f = await setup();
		const response = await f.service.handleRelay(PEER, {
			id: ID, method: "POST", path: "/api/tasks/desktop-task/delta", body: { since: "not-a-version" },
		});
		expect(response.status).toBe(200);
		expect((response.body as AgentSnapshotDelta).full).toBeDefined();
	});

	test("a trimmed tool result is fetched back in full, a chunk at a time", async () => {
		const f = await setup();
		const output = "y".repeat(10_000);
		f.appendCell({
			id: "c2", type: "tool", toolCallId: "tc1", toolName: "read",
			args: {}, output, status: "done", timestamp: 2,
		});
		const fetch = async (body: Record<string, unknown>) =>
			f.service.handleRelay(PEER, { id: ID, method: "POST", path: "/api/tasks/desktop-task/tool-output", body });

		// The transcript itself only carried the head.
		const delta = (await f.service.handleRelay(PEER, {
			id: ID, method: "POST", path: "/api/tasks/desktop-task/delta", body: {},
		})).body as AgentSnapshotDelta;
		const cell = delta.full!.cells.find((c) => c.id === "c2") as Extract<AgentCell, { type: "tool" }>;
		expect(cell.output.length).toBeLessThan(output.length);
		expect(cell.outputTotal).toBe(output.length);

		const rest = await fetch({ toolCallId: "tc1", offset: cell.output.length });
		expect(rest.status).toBe(200);
		const chunk = rest.body as { text: string; offset: number; total: number };
		expect(cell.output + chunk.text).toBe(output);
		expect(chunk.total).toBe(output.length);
	});

	test("the tool-output route validates its call id and reports an unknown one", async () => {
		const f = await setup();
		const call = (body: Record<string, unknown>) =>
			f.service.handleRelay(PEER, { id: ID, method: "POST", path: "/api/tasks/desktop-task/tool-output", body });
		expect((await call({})).status).toBe(400);
		expect((await call({ toolCallId: "x".repeat(201) })).status).toBe(400);
		expect((await call({ toolCallId: "missing" })).status).toBe(404);
	});

	test("unexpected internal errors are generalized to a 500", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nekocode-lan-test-"));
		const tasks = { list: async () => { throw new Error("database exploded internally"); } } as unknown as TaskManager;
		const service = new LanService(dir, tasks);
		fixtures.push({ service, dir });
		const response = await service.handleRelay(PEER, { id: ID, method: "GET", path: "/api/state" });
		expect(response.status).toBe(500);
		expect(response.body).toEqual({ error: "Request failed" });
	});
});
