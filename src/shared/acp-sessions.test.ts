import { describe, expect, test } from "bun:test";
import type { AcpHistoryEntry, AcpSessionSummary } from "./acp";
import { acpSessionRows } from "./acp-sessions";

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
});
