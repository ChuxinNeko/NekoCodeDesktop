import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { checkpointSummaries } from "../../src/main/checkpoint-summaries";
import { cellIdForMessage, findTurnEntry, type AnchorMessage } from "../../src/main/checkpoint-anchor";
import { CHECKPOINT_ENTRY, FILE_MUTATION_ENTRY, checkpointEntries, planReversal, turnStats } from "../../src/main/file-journal";

function fixture() {
	const branch: SessionEntry[] = [];
	const messages: AnchorMessage[] = [];
	const entry = (data: Record<string, unknown>) => {
		const item = { id: `entry-${branch.length}`, timestamp: new Date(branch.length).toISOString(), ...data } as unknown as SessionEntry;
		branch.push(item);
		return item;
	};
	const checkpoint = () => entry({ type: "custom", customType: CHECKPOINT_ENTRY, data: { label: `turn-${branch.length}` } });
	const message = (role: string, extra: Record<string, unknown> = {}) => {
		const value = { role, timestamp: branch.length, content: "example", ...extra };
		messages.push(value);
		return entry({ type: "message", message: value });
	};
	const mutation = (path: string, skipped = false) => entry({ type: "custom", customType: FILE_MUTATION_ENTRY, data: {
		path, before: null, tool: "write", additions: 3, deletions: 1, ...(skipped ? { skipped: "too_large" } : {}),
	} });
	return { branch, messages, entry, checkpoint, message, mutation };
}

/** Existing single-checkpoint operations are the oracle for restoring behavior. */
function reference(branch: SessionEntry[], messages: AnchorMessage[]) {
	return checkpointEntries(branch).map((marker) => {
		const turn = findTurnEntry(branch, marker.id);
		const plan = planReversal(branch, marker.id);
		const stats = turnStats(branch, marker.id);
		return {
			id: marker.id, sessionId: "session", createdAt: marker.timestamp, label: marker.label,
			cellId: cellIdForMessage(messages, turn?.message ?? undefined), conversationRestorable: turn !== null,
			codeRestorable: plan.steps.length > 0, fileCount: stats.files, files: stats.list,
			additions: stats.additions, deletions: stats.deletions, shellRuns: plan.opaqueRuns,
		};
	}).reverse();
}

test("summaries preserve per-turn changes and restoration across a long mixed branch", () => {
	const f = fixture();
	for (let turn = 0; turn < 80; turn++) {
		f.checkpoint();
		f.entry({ type: "model_change", provider: "test", modelId: "test" });
		f.message("system");
		f.message("user");
		f.mutation(`file-${turn % 7}`, turn % 3 === 0);
		f.mutation(`file-${turn % 7}`);
		if (turn % 2) f.message("toolResult", { toolName: "powershell" });
		f.message("assistant");
	}
	expect(checkpointSummaries(f.branch, f.messages, "session")).toEqual(reference(f.branch, f.messages));
});

test("abandoned markers, malformed markers and custom prompts keep their original anchors", () => {
	const f = fixture();
	f.checkpoint(); f.checkpoint(); f.message("system"); f.message("user");
	f.checkpoint(); f.message("assistant"); f.message("user");
	f.checkpoint(); f.entry({ type: "custom", customType: CHECKPOINT_ENTRY, data: null }); f.message("user");
	f.checkpoint();
	const custom = { role: "custom", timestamp: 900 };
	f.entry({ type: "custom_message", message: custom }); f.messages.push(custom);
	expect(checkpointSummaries(f.branch, f.messages, "session")).toEqual(reference(f.branch, f.messages));
});

test("compaction removes cell anchors without removing restorable history", () => {
	const f = fixture();
	f.checkpoint(); f.message("user"); f.mutation("first"); f.checkpoint(); f.message("user");
	f.messages.splice(0, 1);
	f.messages.push(f.messages[0]);
	expect(checkpointSummaries(f.branch, f.messages, "session")).toEqual(reference(f.branch, f.messages));
});

test("the earliest pre-image after each marker controls code restoration", () => {
	const f = fixture();
	f.checkpoint(); f.message("user"); f.mutation("same", true);
	f.checkpoint(); f.message("user"); f.mutation("same");
	f.checkpoint(); f.message("user"); f.mutation("same", true);
	const summaries = checkpointSummaries(f.branch, f.messages, "session");
	expect(summaries.map((summary) => summary.codeRestorable)).toEqual([false, true, false]);
	expect(summaries).toEqual(reference(f.branch, f.messages));
});

test("thousands of checkpoints require a linear number of branch reads", () => {
	const f = fixture();
	for (let index = 0; index < 8000; index++) { f.checkpoint(); f.message("user"); f.mutation(`file-${index}`); }
	let reads = 0;
	const branch = new Proxy(f.branch, { get(target, property, receiver) {
		if (typeof property === "string" && /^\d+$/.test(property)) reads++;
		return Reflect.get(target, property, receiver);
	} });
	expect(checkpointSummaries(branch, f.messages, "session")).toHaveLength(8000);
	expect(reads).toBeLessThanOrEqual(f.branch.length * 3);
});
