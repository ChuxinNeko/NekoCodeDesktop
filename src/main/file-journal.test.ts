import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_ENTRY,
	checkpointEntries,
	checkpointLabel,
	FILE_MUTATION_ENTRY,
	fileMutation,
	packPreimage,
	planReversal,
	turnStats,
	unpackPreimage,
	type FileMutationData,
} from "./file-journal";

let sequence = 0;
function entry(partial: Partial<SessionEntry> & { type: string }): SessionEntry {
	return {
		id: `e${++sequence}`,
		parentId: null,
		timestamp: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
		...partial,
	} as SessionEntry;
}

function checkpoint(label: string): SessionEntry {
	return entry({ type: "custom", customType: CHECKPOINT_ENTRY, data: { label } });
}

function mutation(data: Partial<FileMutationData> & { path: string }): SessionEntry {
	return entry({
		type: "custom",
		customType: FILE_MUTATION_ENTRY,
		data: { before: null, beforeBytes: 0, tool: "write", ...data },
	});
}

function preimage(path: string, contents: string): SessionEntry {
	const buffer = Buffer.from(contents, "utf8");
	return mutation({ path, before: packPreimage(buffer), beforeBytes: buffer.length, tool: "edit" });
}

function toolResult(toolName: string): SessionEntry {
	return entry({ type: "message", message: { role: "toolResult", toolName } as never });
}

function userMessage(text: string): SessionEntry {
	return entry({ type: "message", message: { role: "user", content: text } as never });
}

describe("pre-image packing", () => {
	test("round-trips exactly, bytes for bytes", () => {
		const original = Buffer.from("export const x = 1;\r\n中文\n", "utf8");
		expect(unpackPreimage(packPreimage(original)).equals(original)).toBe(true);
	});

	test("compresses the repetitive text a source file is made of", () => {
		const source = Buffer.from("const value = 1;\n".repeat(2000), "utf8");
		expect(packPreimage(source).length).toBeLessThan(source.length / 4);
	});
});

describe("entry recognition", () => {
	test("reads a checkpoint's label", () => {
		expect(checkpointLabel(checkpoint("fix the parser"))).toBe("fix the parser");
	});

	test("anything else is not a checkpoint", () => {
		expect(checkpointLabel(userMessage("hi"))).toBeNull();
		expect(checkpointLabel(mutation({ path: "a.ts" }))).toBeNull();
	});

	test("reads a file mutation, and rejects a malformed one", () => {
		expect(fileMutation(mutation({ path: "a.ts" }))?.path).toBe("a.ts");
		expect(fileMutation(checkpoint("x"))).toBeNull();
		expect(fileMutation(entry({ type: "custom", customType: FILE_MUTATION_ENTRY, data: {} }))).toBeNull();
	});
});

describe("checkpointEntries", () => {
	test("lists markers in branch order", () => {
		const first = checkpoint("one");
		const second = checkpoint("two");
		const found = checkpointEntries([first, userMessage("a"), second, userMessage("b")]);
		expect(found.map((marker) => marker.label)).toEqual(["one", "two"]);
		expect(found[0].id).toBe(first.id);
		expect(found[0].timestamp).toBeGreaterThan(0);
	});
});

describe("planReversal", () => {
	test("collects the changes made after the checkpoint", () => {
		const marker = checkpoint("turn");
		const plan = planReversal(
			[marker, preimage("src/a.ts", "before a"), mutation({ path: "src/new.ts" })],
			marker.id,
		);

		expect(plan.steps.map((step) => step.path)).toEqual(["src/a.ts", "src/new.ts"]);
		// A null pre-image means the agent created the file: undoing that is a delete.
		expect(plan.steps.find((step) => step.path === "src/new.ts")?.before).toBeNull();
	});

	test("ignores everything before the checkpoint", () => {
		const earlier = preimage("src/old.ts", "untouched by this turn");
		const marker = checkpoint("turn");
		const plan = planReversal([earlier, marker, preimage("src/a.ts", "before a")], marker.id);

		expect(plan.steps.map((step) => step.path)).toEqual(["src/a.ts"]);
	});

	test("a file changed twice keeps the earliest pre-image", () => {
		// The first change after the checkpoint is the one holding the contents at
		// the checkpoint; later ones carry pre-images from after it.
		const marker = checkpoint("turn");
		const plan = planReversal(
			[marker, preimage("a.ts", "original"), preimage("a.ts", "intermediate")],
			marker.id,
		);

		expect(plan.steps).toHaveLength(1);
		expect(unpackPreimage(plan.steps[0].before!).toString()).toBe("original");
	});

	test("counts shell runs separately — their effects were never recorded", () => {
		const marker = checkpoint("turn");
		const plan = planReversal(
			[marker, toolResult("bash"), preimage("a.ts", "x"), toolResult("powershell")],
			marker.id,
		);

		expect(plan.opaqueRuns).toBe(2);
		expect(plan.steps).toHaveLength(1);
	});

	test("shell runs before the checkpoint are not counted", () => {
		const marker = checkpoint("turn");
		expect(planReversal([toolResult("bash"), marker], marker.id).opaqueRuns).toBe(0);
	});

	test("a file whose pre-image was never kept is reported, not silently dropped", () => {
		const marker = checkpoint("turn");
		const plan = planReversal(
			[marker, mutation({ path: "big.bin", skipped: "too-large", beforeBytes: 9_000_000 })],
			marker.id,
		);

		expect(plan.steps).toHaveLength(0);
		expect(plan.unrestorable.map((step) => step.path)).toEqual(["big.bin"]);
	});

	test("a checkpoint that is not on the branch plans nothing", () => {
		// What a checkpoint from an abandoned branch looks like after a rewind.
		expect(planReversal([checkpoint("a"), preimage("x.ts", "y")], "missing").steps).toEqual([]);
	});

	test("a checkpoint with nothing after it plans nothing", () => {
		const marker = checkpoint("turn");
		const plan = planReversal([preimage("a.ts", "x"), marker], marker.id);
		expect(plan).toEqual({ steps: [], unrestorable: [], opaqueRuns: 0 });
	});

	test("a tool result that is not a shell is not counted as one", () => {
		const marker = checkpoint("turn");
		expect(planReversal([marker, toolResult("read"), toolResult("grep")], marker.id).opaqueRuns).toBe(0);
	});
});

describe("turnStats", () => {
	test("sums the lines each tool call recorded", () => {
		const marker = checkpoint("turn");
		const stats = turnStats(
			[
				marker,
				mutation({ path: "a.ts", additions: 3, deletions: 1 }),
				mutation({ path: "b.ts", additions: 10, deletions: 2 }),
			],
			marker.id,
		);

		expect(stats).toEqual({ files: 2, additions: 13, deletions: 3 });
	});

	test("a file changed twice counts once but keeps both calls' lines", () => {
		const marker = checkpoint("turn");
		const stats = turnStats(
			[
				marker,
				mutation({ path: "a.ts", additions: 5, deletions: 0 }),
				mutation({ path: "a.ts", additions: 2, deletions: 4 }),
			],
			marker.id,
		);

		expect(stats).toEqual({ files: 1, additions: 7, deletions: 4 });
	});

	test("stops at the next checkpoint — a later turn is not this one's work", () => {
		const marker = checkpoint("first");
		const next = checkpoint("second");
		const stats = turnStats(
			[
				marker,
				mutation({ path: "a.ts", additions: 2, deletions: 1 }),
				next,
				mutation({ path: "b.ts", additions: 9, deletions: 9 }),
			],
			marker.id,
		);

		expect(stats).toEqual({ files: 1, additions: 2, deletions: 1 });
	});

	test("mutations without recorded lines still count their files", () => {
		const marker = checkpoint("turn");
		const stats = turnStats(
			[marker, mutation({ path: "a.ts" }), mutation({ path: "b.ts", additions: 1 })],
			marker.id,
		);

		expect(stats).toEqual({ files: 2, additions: 1, deletions: 0 });
	});

	test("a checkpoint that is not on the branch has no stats", () => {
		expect(turnStats([mutation({ path: "a.ts", additions: 5 })], "missing")).toEqual({
			files: 0,
			additions: 0,
			deletions: 0,
		});
	});
});
