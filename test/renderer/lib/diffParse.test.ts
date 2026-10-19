import { describe, expect, test } from "bun:test";
import { changedSpan, pairedSpans, parseDiff, toSplitRows } from "../../../src/renderer/src/components/review/diff-parse";

const PATCH = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,4 +1,5 @@ function top()",
	" keep one",
	"-old line",
	"-second old",
	"+new line",
	"+second new",
	"+extra",
	" keep two",
	"@@ -20 +21 @@",
	"--- looks like a header but is a removed line",
	"+++ looks like a header but is an added line",
	"\\ No newline at end of file",
].join("\n");

describe("parseDiff", () => {
	test("numbers lines on both sides and counts changes", () => {
		const parsed = parseDiff(PATCH);
		expect(parsed.additions).toBe(4);
		expect(parsed.deletions).toBe(3);
		const rows = parsed.rows.map((r) => [r.kind, r.oldNo, r.newNo]);
		expect(rows.slice(0, 8)).toEqual([
			["hunk", null, null],
			["context", 1, 1],
			["del", 2, null],
			["del", 3, null],
			["add", null, 2],
			["add", null, 3],
			["add", null, 4],
			["context", 4, 5],
		]);
	});

	test("trusts hunk counts, so content that looks like a file header stays content", () => {
		const parsed = parseDiff(PATCH);
		const tail = parsed.rows.slice(-4);
		expect(tail.map((r) => r.kind)).toEqual(["hunk", "del", "add", "note"]);
		expect(tail[1]?.text).toBe("-- looks like a header but is a removed line");
		expect(tail[1]?.oldNo).toBe(20);
		expect(tail[2]?.newNo).toBe(21);
	});

	test("reads file metadata", () => {
		expect(parseDiff("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi").meta.isNew).toBe(true);
		expect(parseDiff("diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-hi").meta.isDeleted).toBe(true);
		expect(parseDiff("diff --git a/x b/x\nBinary files a/x and b/x differ").meta.isBinary).toBe(true);
		const rename = parseDiff("diff --git a/old b/new\nsimilarity index 90%\nrename from old\nrename to new\n").meta;
		expect([rename.renameFrom, rename.renameTo]).toEqual(["old", "new"]);
		expect(parseDiff("diff --git a/x b/x\nold mode 100644\nnew mode 100755").meta.modeChange).toBe("100644 → 100755");
	});

	test("shows the path of every later file in a multi-file patch", () => {
		const parsed = parseDiff("diff --git a/a b/a\n@@ -1 +1 @@\n-1\n+2\ndiff --git a/b b/b\nnew file mode 100644\n@@ -0,0 +1 @@\n+x");
		expect(parsed.rows.filter((r) => r.kind === "file").map((r) => r.text)).toEqual(["b"]);
		expect(parsed.meta.isNew).toBe(false);
		expect(parsed.additions).toBe(2);
	});

	test("empty patches and blank context lines", () => {
		expect(parseDiff("").rows).toEqual([]);
		const parsed = parseDiff("@@ -1,3 +1,3 @@\n a\n\n-b\n+c");
		expect(parsed.rows.map((r) => r.kind)).toEqual(["hunk", "context", "context", "del", "add"]);
	});
});

describe("split view", () => {
	test("faces the n-th removal with the n-th addition and pads the longer side", () => {
		const split = toSplitRows(parseDiff(PATCH).rows);
		const shape = split.map((row) => (row.type === "full" ? row.row.kind : `${row.left?.kind ?? "-"}|${row.right?.kind ?? "-"}`));
		expect(shape.slice(0, 6)).toEqual(["hunk", "context|context", "del|add", "del|add", "-|add", "context|context"]);
	});

	test("an addition with no removal faces a blank", () => {
		const split = toSplitRows(parseDiff("@@ -0,0 +1 @@\n+only").rows);
		expect(split[1]).toMatchObject({ type: "pair", left: null });
	});
});

describe("inline highlight", () => {
	test("marks only what changed between common prefix and suffix", () => {
		expect(changedSpan("const total = 10;", "const total = 25;")).toEqual({ before: [14, 16], after: [14, 16] });
		expect(changedSpan("a", "a")).toBeNull();
		expect(changedSpan("abc", "xyz")).toBeNull();
		expect(changedSpan("x".repeat(500), "y".repeat(500))).toBeNull();
		// Pure insertion: the removed side has an empty span.
		expect(changedSpan("foo()", "foo(bar)")).toEqual({ before: [4, 4], after: [4, 7] });
	});

	test("pairs spans by position inside a run", () => {
		const rows = parseDiff(PATCH).rows;
		const spans = pairedSpans(rows);
		const del = rows.find((r) => r.kind === "del")!;
		const add = rows.find((r) => r.kind === "add")!;
		expect(spans.get(del)).toEqual([0, 3]);
		expect(spans.get(add)).toEqual([0, 3]);
		expect(spans.size).toBeGreaterThan(0);
	});
});
