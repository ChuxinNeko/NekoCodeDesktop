import { describe, expect, test } from "bun:test";
import type { AgentService } from "./agent-service";
import type { AgentCell, AgentSnapshot, OpenSessionRequest, SessionSummary } from "../shared/agent";
import { DESKTOP_LIMITS } from "./agent-remote-view";
import { TaskManager } from "./task-manager";

function fixture() {
	let nextId = 0;
	const events: Array<{ channel: string; payload?: unknown }> = [];
	const agents: FakeAgent[] = [];
	const disk = new Map<string, SessionSummary>();
	/** Set to make the next `send` refuse its prompt, the way no configured model would. */
	let refuseNext: string | null = null;
	class FakeAgent {
		snapshot: AgentSnapshot | null = null;
		closed = false;
		aborts = 0;
		sent: string[] = [];
		constructor(readonly emit: (channel: string, payload?: unknown) => void, readonly owner?: AgentService) {}
		getSnapshot() { return this.snapshot; }
		inheritDefaults() {}
		async createSession(cwd: string) {
			const id = `task-${++nextId}`;
			this.snapshot = {
				session: { id, cwd, sessionFile: `/sessions/${id}.jsonl`, title: id, titlePending: false, preview: "", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
				cells: [], checkpoints: [], fastContext: { modelKey: null, thinkingLevel: "low" }, workflow: { request: null, todos: [], tasks: [] }, streaming: false,
				models: [], modelKey: null, thinkingLevel: "off", thinkingLevels: ["off"], mode: "auto", workMode: "agent", agentPhase: "execute",
			};
			this.emit("agent:snapshot", this.snapshot);
			return this.snapshot;
		}
		async openSession(req: OpenSessionRequest) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			await this.createSession(req.cwd);
			this.snapshot = { ...this.snapshot!, session: { ...this.snapshot!.session, sessionFile: req.sessionFile } };
			this.emit("agent:snapshot", this.snapshot);
			return this.snapshot;
		}
		run(running = true) {
			this.snapshot = { ...this.snapshot!, streaming: running, session: { ...this.snapshot!.session, running } };
			this.emit("agent:snapshot", this.snapshot);
		}
		async send({ text }: { text: string }) {
			const refusal = refuseNext;
			refuseNext = null;
			if (refusal) return { accepted: false as const, error: refusal };
			this.sent.push(text);
			// A first prompt is what names the row, so the caller re-reading the
			// snapshot after the send has to see the new title rather than the id.
			this.snapshot = { ...this.snapshot!, session: { ...this.snapshot!.session, title: text } };
			this.run();
			return { accepted: true as const };
		}
		async listSessions() { return [...disk.values()]; }
		async abort() { this.aborts++; this.run(false); }
		async deleteSession() { this.snapshot = null; this.emit("agent:snapshot", null); }
		async renameSession(req: { title: string }) { this.snapshot = { ...this.snapshot!, session: { ...this.snapshot!.session, title: req.title } }; this.emit("agent:snapshot", this.snapshot); }
		close() { this.closed = true; }
	}
	const manager = new TaskManager((emit, owner) => {
		const agent = new FakeAgent(emit, owner); agents.push(agent); return agent as unknown as AgentService;
	}, (channel, payload) => events.push({ channel, payload }));
	return {
		manager, agents, events, disk,
		fake: (agent: AgentService) => agent as unknown as FakeAgent,
		/** The most recently made agent — what a background start just created. */
		last: () => agents[agents.length - 1],
		refuseNext: (error: string) => { refuseNext = error; },
	};
}

describe("parallel task execution", () => {
	test("phone creation preserves the desktop selection and includes unflushed tasks in the sidebar", async () => {
		const f = fixture();
		const desktop = f.fake(await f.manager.create("/project")); desktop.run();
		f.events.length = 0;
		const phone = f.fake(await f.manager.create("/project", false)); phone.run();
		expect(f.manager.active).toBe(desktop as unknown as AgentService);
		expect(desktop.closed).toBe(false);
		expect(desktop.snapshot!.streaming).toBe(true);
		expect(f.events.some((e) => e.channel === "agent:sessionsChanged")).toBe(true);
		expect(f.events.filter((e) => e.channel === "agent:snapshot")).toHaveLength(0);
		expect((await f.manager.list()).filter((s) => s.running)).toHaveLength(2);
		expect(phone.owner).toBe(f.manager.owner);
	});

	test("selecting an existing running task reuses its instance, and abort affects only that task", async () => {
		const f = fixture(); const a = f.fake(await f.manager.create("/a")); a.run();
		const b = f.fake(await f.manager.create("/b", false)); b.run();
		const selected = await f.manager.open(b.snapshot!.session);
		expect(selected).toBe(b as unknown as AgentService);
		expect(f.manager.active).toBe(selected);
		expect(a.closed).toBe(false);
		await selected.abort();
		expect(a.snapshot!.streaming).toBe(true);
		expect((await f.manager.list()).find((s) => s.id === b.snapshot!.session.id)?.running).toBe(false);
	});

	test("a growing transcript only nudges the sidebar when it gets its first message", async () => {
		const f = fixture();
		const agent = f.fake(await f.manager.create("/project"));
		agent.run();
		const grow = (messageCount: number) => {
			agent.snapshot = { ...agent.snapshot!, session: { ...agent.snapshot!.session, messageCount } };
			agent.emit("agent:snapshot", agent.snapshot);
		};
		const nudges = () => f.events.filter((e) => e.channel === "agent:sessionsChanged").length;
		f.events.length = 0;
		grow(1);
		expect(nudges()).toBe(1);
		for (let count = 2; count < 50; count++) grow(count);
		expect(nudges()).toBe(1);
		// The run ending is still announced.
		agent.run(false);
		expect(nudges()).toBe(2);
	});

	test("opening a session answers with the snapshot it selected, without building another", async () => {
		const f = fixture();
		const agent = await f.manager.create("/project");
		const fake = f.fake(agent);
		let builds = 0;
		const getSnapshot = fake.getSnapshot.bind(fake);
		fake.getSnapshot = () => { builds++; return getSnapshot(); };
		const opened = await f.manager.open(fake.snapshot!.session);
		expect(builds).toBe(1);
		expect(f.manager.viewOf(opened)?.session).toEqual(fake.snapshot!.session);
		expect(builds).toBe(1);
	});

	test("simultaneous history reads create only one execution owner without changing desktop selection", async () => {
		const f = fixture(); const active = await f.manager.create("/active");
		const req = { cwd: "/history", sessionFile: "/sessions/history.jsonl" };
		const [one, two] = await Promise.all([f.manager.open(req, false), f.manager.open(req, false)]);
		expect(one).toBe(two); expect(f.manager.active).toBe(active);
	});

	test("a background prompt runs in its own session and leaves the desktop where it was", async () => {
		const f = fixture();
		const desktop = f.fake(await f.manager.create("/project"));
		desktop.run();
		f.events.length = 0;

		const result = await f.manager.startBackground("/project", "整理一下 README");

		expect(result.accepted).toBe(true);
		if (!result.accepted) return;
		// Read after the send, so the row carries the prompt rather than a placeholder.
		expect(result.session.title).toBe("整理一下 README");
		expect(f.manager.active).toBe(desktop as unknown as AgentService);
		expect(desktop.snapshot!.streaming).toBe(true);
		// The window hears about the new task through the sidebar, not the transcript.
		expect(f.events.filter((e) => e.channel === "agent:snapshot")).toHaveLength(0);
		expect(f.events.some((e) => e.channel === "agent:sessionsChanged")).toBe(true);
		expect(f.last().sent).toEqual(["整理一下 README"]);
		const rows = await f.manager.list();
		expect(rows).toHaveLength(2);
		expect(rows.find((s) => s.id === result.session.id)?.running).toBe(true);
	});

	test("a refused background prompt leaves no session behind", async () => {
		const f = fixture();
		const desktop = f.fake(await f.manager.create("/project"));
		f.refuseNext("当前模型配置已被移除，请添加或选择可用模型");

		const result = await f.manager.startBackground("/project", "整理一下 README");

		expect(result).toEqual({ accepted: false, error: "当前模型配置已被移除，请添加或选择可用模型" });
		expect(f.last().closed).toBe(true);
		expect(f.manager.active).toBe(desktop as unknown as AgentService);
		expect(await f.manager.list()).toHaveLength(1);
	});

	test("rename and delete route to the background owner, and shutdown closes every task", async () => {
		const f = fixture(); const active = await f.manager.create("/a");
		const background = f.fake(await f.manager.create("/b", false)); background.run();
		const row = background.snapshot!.session;
		await f.manager.rename({ ...row, title: "手机任务" });
		expect((await f.manager.list()).find((s) => s.id === row.id)?.title).toBe("手机任务");
		await f.manager.remove(row.sessionFile);
		expect(background.aborts).toBe(1); expect(background.closed).toBe(true);
		expect(f.manager.active).toBe(active);
		expect((await f.manager.list()).some((s) => s.id === row.id)).toBe(false);
		f.manager.close(); expect(f.agents.every((a) => a.closed)).toBe(true);
	});
});

describe("desktop transcript window", () => {
	const userCell = (i: number): AgentCell => ({ id: `u${String(i)}`, type: "user", text: `prompt ${String(i)}`, timestamp: i });
	const cells = (count: number, from = 0) => Array.from({ length: count }, (_, i) => userCell(from + i));
	const pushed = (f: ReturnType<typeof fixture>) =>
		f.events.filter((e) => e.channel === "agent:snapshot").map((e) => e.payload as AgentSnapshot).at(-1)!;

	async function longSession(f: ReturnType<typeof fixture>, count: number) {
		const agent = f.fake(await f.manager.create("/project", false));
		agent.snapshot = { ...agent.snapshot!, cells: cells(count) };
		return agent;
	}

	test("opening a long session sends only its tail, and says how much is behind it", async () => {
		const f = fixture();
		const agent = await longSession(f, 500);
		const opened = await f.manager.open(agent.snapshot!.session);
		const view = f.manager.viewOf(opened)!;
		expect(view.cells).toHaveLength(DESKTOP_LIMITS.window);
		expect(view.cells.at(-1)!.id).toBe("u499");
		expect(view.earlierCells).toBe(500 - DESKTOP_LIMITS.window);
		expect(pushed(f).cells).toHaveLength(DESKTOP_LIMITS.window);
	});

	test("a short session is sent whole, with nothing marked as behind it", async () => {
		const f = fixture();
		const agent = await longSession(f, 5);
		const view = f.manager.viewOf(await f.manager.open(agent.snapshot!.session))!;
		expect(view.cells).toHaveLength(5);
		expect(view.earlierCells).toBeUndefined();
	});

	test("the window stays pinned while the run adds cells, and pages back on request", async () => {
		const f = fixture();
		const agent = await longSession(f, 500);
		await f.manager.open(agent.snapshot!.session);
		const first = pushed(f).cells[0].id;
		agent.snapshot = { ...agent.snapshot!, cells: [...agent.snapshot!.cells, ...cells(10, 500)] };
		agent.emit("agent:snapshot", agent.snapshot);
		expect(pushed(f).cells[0].id).toBe(first);
		expect(pushed(f).cells).toHaveLength(DESKTOP_LIMITS.window + 10);

		const earlier = f.manager.loadEarlier()!;
		expect(earlier.cells).toHaveLength(DESKTOP_LIMITS.window + DESKTOP_LIMITS.step + 10);
		expect(earlier.earlierCells).toBe(500 - DESKTOP_LIMITS.window - DESKTOP_LIMITS.step);
		// Later pushes keep what was paged in.
		agent.emit("agent:snapshot", agent.snapshot);
		expect(pushed(f).cells[0].id).toBe(earlier.cells[0].id);
	});

	test("switching back to a session starts it at its end again", async () => {
		const f = fixture();
		const agent = await longSession(f, 500);
		const other = f.fake(await f.manager.create("/other", false));
		await f.manager.open(agent.snapshot!.session);
		f.manager.loadEarlier();
		await f.manager.open(other.snapshot!.session);
		await f.manager.open(agent.snapshot!.session);
		expect(pushed(f).cells).toHaveLength(DESKTOP_LIMITS.window);
	});

	test("oversized tool output reaches the window as a head it can fetch the rest of", async () => {
		const f = fixture();
		const agent = f.fake(await f.manager.create("/project", false));
		const output = "x".repeat(DESKTOP_LIMITS.fieldLimit + 100);
		agent.snapshot = {
			...agent.snapshot!,
			cells: [{ id: "t1", type: "tool", toolCallId: "call-1", toolName: "read", args: {}, output, status: "done", timestamp: 1 }],
		};
		const view = f.manager.viewOf(await f.manager.open(agent.snapshot!.session))!;
		const [cell] = view.cells;
		if (cell.type !== "tool") throw new Error("expected a tool cell");
		expect(cell.output).toHaveLength(DESKTOP_LIMITS.fieldLimit);
		expect(cell.outputTotal).toBe(output.length);
	});

	test("every snapshot pushed for the selected session is windowed", async () => {
		const f = fixture();
		const agent = await longSession(f, 500);
		await f.manager.open(agent.snapshot!.session);
		agent.emit("agent:snapshot", agent.snapshot);
		for (const event of f.events.filter((e) => e.channel === "agent:snapshot"))
			expect((event.payload as AgentSnapshot).cells.length).toBeLessThanOrEqual(DESKTOP_LIMITS.window);
	});
});
