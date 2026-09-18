import { describe, expect, test } from "bun:test";
import type { AgentCell } from "./agent";
import { groupTranscriptRows, workToolCount, type WorkRow } from "./transcript";

const user = (id: string, timestamp: number): AgentCell => ({
	id,
	type: "user",
	text: "do the thing",
	timestamp,
});

const assistant = (
	id: string,
	fields: Partial<Extract<AgentCell, { type: "assistant" }>>,
): AgentCell => ({
	id,
	type: "assistant",
	text: "",
	thinking: "",
	streaming: false,
	timestamp: 0,
	...fields,
});

const tool = (id: string, fields: Partial<Extract<AgentCell, { type: "tool" }>> = {}): AgentCell => ({
	id,
	type: "tool",
	toolCallId: id,
	toolName: "bash",
	args: { command: "ls" },
	output: "ok",
	status: "done",
	timestamp: 0,
	...fields,
});

const notice = (id: string, timestamp: number): AgentCell => ({
	id,
	type: "notice",
	level: "info",
	text: "Compacting context…",
	timestamp,
});

const work = (rows: ReturnType<typeof groupTranscriptRows>, index = 0): WorkRow => {
	const row = rows.filter((r): r is WorkRow => r.kind === "work")[index];
	if (!row) throw new Error("no work row");
	return row;
};

describe("groupTranscriptRows", () => {
	test("folds thinking and tool calls into one group, leaving the answer outside", () => {
		const rows = groupTranscriptRows([
			user("u1", 1000),
			assistant("a1", { thinking: "planning", timestamp: 1100, thinkingEndedAt: 1500 }),
			tool("t1", { startedAt: 1500, timestamp: 2000 }),
			assistant("a2", { text: "done", timestamp: 2100 }),
		]);

		expect(rows.map((row) => row.kind)).toEqual(["user", "work", "message"]);
		expect(work(rows).items.map((item) => item.kind)).toEqual(["thinking", "tool"]);
	});

	test("one assistant cell splits: its thinking joins the group, its text closes it", () => {
		const rows = groupTranscriptRows([
			user("u1", 1000),
			tool("t1", { startedAt: 1100, timestamp: 1400 }),
			assistant("a1", {
				thinking: "checking",
				text: "here it is",
				timestamp: 1500,
				thinkingStartedAt: 1500,
				thinkingEndedAt: 1900,
			}),
		]);

		expect(rows.map((row) => row.kind)).toEqual(["user", "work", "message"]);
		expect(work(rows).items.map((item) => item.kind)).toEqual(["tool", "thinking"]);
		// The group ran until this message stopped thinking and started speaking,
		// not until the message began — it began before it did any of the talking.
		expect(work(rows).startedAt).toBe(1100);
		expect(work(rows).endedAt).toBe(1900);
	});

	test("spans from the call that opened the work to the answer that ended it", () => {
		const rows = groupTranscriptRows([
			user("u1", 1000),
			tool("t1", { startedAt: 1200, timestamp: 5000 }),
			assistant("a1", { text: "done", timestamp: 6000 }),
		]);

		expect(work(rows).startedAt).toBe(1200);
		expect(work(rows).endedAt).toBe(6000);
	});

	test("a turn that only thought is not wrapped in a second level", () => {
		const rows = groupTranscriptRows([
			user("u1", 1000),
			assistant("a1", { thinking: "hmm", text: "hello", timestamp: 1100 }),
		]);

		expect(rows.map((row) => row.kind)).toEqual(["user", "thinking", "message"]);
	});

	test("text between tool calls opens a second group", () => {
		const rows = groupTranscriptRows([
			user("u1", 1000),
			tool("t1", { timestamp: 1100 }),
			assistant("a1", { text: "first", timestamp: 1200 }),
			tool("t2", { timestamp: 1300 }),
			assistant("a2", { text: "second", timestamp: 1400 }),
		]);

		expect(rows.map((row) => row.kind)).toEqual(["user", "work", "message", "work", "message"]);
		expect(rows.map((row) => row.id).filter((id) => id.startsWith("work"))).toEqual([
			"work-u1-0",
			"work-u1-1",
		]);
	});

	test("group ids stay put when the streaming cell is replaced by the persisted one", () => {
		const streaming = groupTranscriptRows([
			user("u1", 1000),
			assistant("assistant-stream-1100", { thinking: "hmm", timestamp: 1100 }),
			tool("t1", { status: "running", startedAt: 1200, timestamp: 1200 }),
		]);
		const persisted = groupTranscriptRows([
			user("u1", 1000),
			assistant("assistant-1100-1", { thinking: "hmm", timestamp: 1100 }),
			tool("t1", { startedAt: 1200, timestamp: 1500 }),
		]);

		expect(work(streaming).id).toBe(work(persisted).id);
	});

	test("a notice joins the work it interrupted but never opens a group alone", () => {
		const inside = groupTranscriptRows([
			user("u1", 1000),
			tool("t1", { timestamp: 1100 }),
			notice("n1", 1200),
			tool("t2", { timestamp: 1300 }),
		]);
		expect(inside.map((row) => row.kind)).toEqual(["user", "work"]);
		expect(work(inside).items.map((item) => item.kind)).toEqual(["tool", "notice", "tool"]);

		const alone = groupTranscriptRows([user("u1", 1000), notice("n1", 1200)]);
		expect(alone.map((row) => row.kind)).toEqual(["user", "notice"]);
	});

	test("a turn's usage keeps its place under the work even with no text", () => {
		const rows = groupTranscriptRows([
			user("u1", 1000),
			tool("t1", { timestamp: 1100 }),
			assistant("a1", {
				timestamp: 1200,
				usage: {
					provider: "anthropic",
					model: "m",
					calls: 1,
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
				},
			}),
		]);

		expect(rows.map((row) => row.kind)).toEqual(["user", "work", "message"]);
	});

	test("counts the tool calls a collapsed header stands in for", () => {
		const rows = groupTranscriptRows([
			user("u1", 1000),
			assistant("a1", { thinking: "hmm", timestamp: 1100 }),
			tool("t1", { timestamp: 1200 }),
			tool("t2", { timestamp: 1300 }),
		]);

		expect(workToolCount(work(rows))).toBe(2);
	});

	test("an empty transcript has no rows", () => {
		expect(groupTranscriptRows([])).toEqual([]);
	});
});
