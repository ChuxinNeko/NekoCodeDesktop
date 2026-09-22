import { describe, expect, test } from "bun:test";
import type { AgentService } from "./agent-service";
import type { AgentSnapshot, OpenSessionRequest, SessionSummary } from "../shared/agent";
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
				cells: [], checkpoints: [], workflow: { request: null, todos: [], tasks: [] }, streaming: false,
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
