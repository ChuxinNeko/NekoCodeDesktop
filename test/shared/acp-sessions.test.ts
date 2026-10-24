import { describe, expect, test } from "bun:test";
import type { AcpHistoryEntry, AcpSessionSummary } from "../../src/shared/acp";
import { acpAgentsRows, acpSessionRows } from "../../src/shared/acp-sessions";
import { reconcileSessionRows } from "../../src/shared/sessions";

const live = (overrides: Partial<AcpSessionSummary>): AcpSessionSummary => ({
	id: "local-1",
	agentId: "codex",
	agentName: "Codex",
	cwd: "D:/p",
	title: "Codex",
	status: "ready",
	pristine: false,
	createdAt: 100,
	updatedAt: 100,
	...overrides,
});

const entry = (overrides: Partial<AcpHistoryEntry>): AcpHistoryEntry => ({
	sessionId: "s1",
	cwd: "D:/p",
	title: "From history",
	updatedAt: 50,
	...overrides,
});

describe("acpSessionRows", () => {
	test("opening and refreshing an older Codex conversation keeps its sidebar position", () => {
		const history = [entry({ sessionId: "newer", updatedAt: 100 }), entry({ sessionId: "older", updatedAt: 10 })];
		const initial = acpSessionRows("codex", history, []).rows;
		const opened = acpSessionRows("codex", history, [live({ agentSessionId: "older", updatedAt: 9999, title: "Opened title" })]).rows;
		const afterOpen = reconcileSessionRows(initial, opened);
		const updated = acpSessionRows("codex", [history[0], { ...history[1], updatedAt: 20000 }], [live({ agentSessionId: "older", status: "prompting", title: "New title" })]).rows;
		const afterRefresh = reconcileSessionRows(afterOpen, updated);
		expect(afterRefresh.map((row) => row.id)).toEqual(["acp:codex:newer", "acp:codex:older"]);
		expect(afterRefresh[1]).toMatchObject({ title: "New title", running: true, updatedAt: 20000 });
	});
	test("an open conversation that is also in the history is one row", () => {
		const { rows, targets } = acpSessionRows(
			"codex",
			[entry({ sessionId: "s1", updatedAt: 500 }), entry({ sessionId: "s2", title: "Other", updatedAt: 40 })],
			[live({ agentSessionId: "s1" })],
		);
		expect(rows.map((row) => [row.id, row.title])).toEqual([
			["acp:codex:s1", "From history"],
			["acp:codex:s2", "Other"],
		]);
		expect(targets.get("acp:codex:s1")).toEqual({ kind: "live", sessionId: "local-1" });
		expect(targets.get("acp:codex:s2")).toMatchObject({ kind: "history", entry: { sessionId: "s2" } });
	});

	test("opening an old conversation does not make it look recent", () => {
		const { rows } = acpSessionRows("codex", [entry({ sessionId: "s1", updatedAt: 50 })], [live({ agentSessionId: "s1", updatedAt: 9_000 })]);
		expect(rows[0].updatedAt).toBe(50);
	});

	test("a new conversation shows before the agent has named it, and runs", () => {
		const { rows } = acpSessionRows("codex", [], [live({ status: "starting", title: "hello", updatedAt: 900 })]);
		expect(rows).toMatchObject([{ id: "acp:codex:local:local-1", title: "hello", running: true }]);
	});

	test("a session opened ahead of its first message is not a row", () => {
		expect(acpSessionRows("codex", [], [live({ pristine: true })]).rows).toEqual([]);
	});

	test("other agents' sessions stay out", () => {
		const { rows } = acpSessionRows("codex", [], [live({ agentId: "claude" })]);
		expect(rows).toEqual([]);
	});

	test("an untitled history entry still gets a label", () => {
		const { rows } = acpSessionRows("codex", [entry({ title: "" })], []);
		expect(rows[0].title).toBe("未命名会话");
	});

	test("every row says which agent it belongs to", () => {
		const { rows } = acpSessionRows("codex", [entry({ sessionId: "s2" })], [live({ agentSessionId: "s1" })]);
		expect(rows.map((row) => row.agentId)).toEqual(["codex", "codex"]);
	});
});

describe("acpAgentsRows", () => {
	test("agents' conversations interleave newest first, each leading to its own agent", () => {
		const { rows, targets } = acpAgentsRows(
			["codex", "claude"],
			{
				codex: [entry({ sessionId: "c1", updatedAt: 10 })],
				claude: [entry({ sessionId: "k1", updatedAt: 30 })],
			},
			[live({ id: "local-c2", agentId: "codex", agentSessionId: "c2", updatedAt: 20 })],
		);
		expect(rows.map((row) => [row.id, row.agentId])).toEqual([
			["acp:claude:k1", "claude"],
			["acp:codex:c2", "codex"],
			["acp:codex:c1", "codex"],
		]);
		expect(targets.get("acp:codex:c2")).toEqual({ kind: "live", sessionId: "local-c2", agentId: "codex" });
		expect(targets.get("acp:claude:k1")).toMatchObject({ kind: "history", agentId: "claude" });
	});

	test("an agent that is not listed brings none of its sessions", () => {
		const { rows } = acpAgentsRows(["codex"], { claude: [entry({})] }, [live({ agentId: "claude" })]);
		expect(rows).toEqual([]);
	});
});
