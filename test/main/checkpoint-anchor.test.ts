import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findTurnEntry, replyEntry } from "../../src/main/checkpoint-anchor";
import { CHECKPOINT_ENTRY } from "../../src/main/file-journal";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });

describe("checkpoint prompt anchor", () => {
	test("a checkpoint left behind by a rewind cannot claim the replacement turn", () => {
		const sm = SessionManager.inMemory("/project");
		const original = sm.appendCustomEntry(CHECKPOINT_ENTRY, { label: "original" });
		sm.appendMessage(user("original", 1));
		sm.appendMessage(reply("answer", 2) as never);
		// navigateTree(user) rewinds to that user's parent, retaining its marker.
		sm.branch(original);
		const replacement = sm.appendCustomEntry(CHECKPOINT_ENTRY, { label: "replacement" });
		const prompt = sm.appendMessage(user("replacement", 3));
		expect(findTurnEntry(sm.getBranch(), original)).toBeNull();
		expect(findTurnEntry(sm.getBranch(), replacement)?.id).toBe(prompt);
		// Repeating the restore must keep every abandoned marker unattached.
		sm.branch(replacement);
		const newest = sm.appendCustomEntry(CHECKPOINT_ENTRY, { label: "newest" });
		const newestPrompt = sm.appendMessage(user("newest", 4));
		expect(findTurnEntry(sm.getBranch(), original)).toBeNull();
		expect(findTurnEntry(sm.getBranch(), replacement)).toBeNull();
		expect(findTurnEntry(sm.getBranch(), newest)?.id).toBe(newestPrompt);
	});

	test("skips system declarations and model bookkeeping before the user prompt", () => {
		const branch = [{ id: "checkpoint", type: "custom" }, { id: "model", type: "model_change" },
			{ id: "system", type: "message", message: { role: "system" } },
			{ id: "prompt", type: "message", message: { role: "user" } }];
		expect(findTurnEntry(branch, "checkpoint")?.id).toBe("prompt");
	});
	test("does not cross an assistant response to attach a different user's changes", () => {
		const branch = [{ id: "checkpoint", type: "custom" }, { id: "system", type: "message", message: { role: "system" } },
			{ id: "answer", type: "message", message: { role: "assistant" } },
			{ id: "other", type: "message", message: { role: "user" } }];
		expect(findTurnEntry(branch, "checkpoint")).toBeNull();
	});
});
const reply = (text: string, timestamp: number) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "openai-completions",
	provider: "test",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop" as const,
	timestamp,
});

/** A saved two-turn conversation, and the context the agent would hold for it. */
function conversation() {
	const dir = mkdtempSync(join(tmpdir(), "neko-fork-"));
	dirs.push(dir);
	const sm = SessionManager.create(dir, dir);
	sm.appendMessage(user("first", 1));
	sm.appendMessage(reply("answer one", 2) as never);
	sm.appendMessage(user("second", 3));
	sm.appendMessage(reply("answer two", 4) as never);
	return { sm, dir, messages: sm.buildSessionContext().messages };
}

describe("replyEntry", () => {
	test("finds the entry behind a reply cell, by the message the context holds", () => {
		const { sm, messages } = conversation();
		const entry = replyEntry(sm.getBranch(), messages, `assistant-2-1`);
		expect(entry?.type).toBe("message");
		expect((entry?.message as { content: { text: string }[] }).content[0].text).toBe("answer one");
	});

	test("refuses prompts, unknown ids and messages outside the context", () => {
		const { sm, messages } = conversation();
		expect(replyEntry(sm.getBranch(), messages, "user-1-0")).toBeNull();
		expect(replyEntry(sm.getBranch(), messages, "assistant-1-0")).toBeNull();
		expect(replyEntry(sm.getBranch(), messages, "assistant-9-9")).toBeNull();
		expect(replyEntry(sm.getBranch(), [...messages.map((m) => ({ ...m }))], "assistant-2-1")).toBeNull();
	});

	test("a branch at the first reply is a new session holding just the first turn, and the original is untouched", () => {
		const { sm, dir, messages } = conversation();
		const entry = replyEntry(sm.getBranch(), messages, "assistant-2-1");
		const original = sm.getSessionFile() as string;
		const copy = SessionManager.open(original, dir);
		const forked = copy.createBranchedSession(entry!.id) as string;
		copy.appendSessionInfo("first · 分支");

		expect(forked).not.toBe(original);
		const branch = SessionManager.open(forked, dir);
		expect(branch.buildSessionContext().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(branch.getSessionName()).toBe("first · 分支");
		expect(SessionManager.open(original, dir).buildSessionContext().messages).toHaveLength(4);
	});
});
