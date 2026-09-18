/**
 * A line differ, because a checkpoint has no git to ask.
 *
 * The review panel gets its patches from `git diff`. Checkpoints cannot: the
 * whole point of them is to work in a directory that was never a repository, on
 * a machine that may have no git at all. What they do have is the file's exact
 * contents before the agent touched it, so the diff is computable here.
 *
 * Emits a unified diff so the same renderer draws both panels.
 */

export interface DiffCounts {
	additions: number;
	deletions: number;
}

export interface LineDiff extends DiffCounts {
	/** Unified diff text, or empty when the two sides are identical. */
	patch: string;
	/** Neither side could be diffed as text. */
	binary: boolean;
}

/** Lines of context kept around each changed run. */
const CONTEXT_LINES = 3;

/**
 * Above this, the middle section is replaced wholesale instead of diffed.
 *
 * The LCS table is quadratic, so a pathological pair of large files — a
 * generated bundle rewritten end to end — would otherwise allocate hundreds of
 * millions of cells to tell the user something they can already see. Two
 * thousand changed lines a side is far past the point where a line-by-line
 * reading is what anyone wants.
 */
const MAX_LCS_LINES = 2000;

/** A NUL in the first few kilobytes is the usual tell, and it is good enough here. */
export function looksBinary(contents: string): boolean {
	return contents.slice(0, 8192).includes("\0");
}

function splitLines(contents: string): string[] {
	if (contents === "") return [];
	const lines = contents.split("\n");
	// A trailing newline ends the last line rather than starting an empty one.
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

type Op = { kind: "equal" | "add" | "remove"; line: string };

/**
 * Longest common subsequence over lines, as a list of operations.
 *
 * Only ever called on the span that actually differs — the common prefix and
 * suffix are stripped first, which in practice reduces a three-line edit in a
 * thousand-line file to a three-line problem.
 */
function lcsOps(before: string[], after: string[]): Op[] {
	if (before.length === 0) return after.map((line) => ({ kind: "add", line }) as const);
	if (after.length === 0) return before.map((line) => ({ kind: "remove", line }) as const);
	if (before.length > MAX_LCS_LINES || after.length > MAX_LCS_LINES) {
		return [
			...before.map((line) => ({ kind: "remove", line }) as const),
			...after.map((line) => ({ kind: "add", line }) as const),
		];
	}

	const rows = before.length + 1;
	const columns = after.length + 1;
	const table = new Uint32Array(rows * columns);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			table[i * columns + j] =
				before[i] === after[j]
					? table[(i + 1) * columns + j + 1] + 1
					: Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length && j < after.length) {
		if (before[i] === after[j]) {
			ops.push({ kind: "equal", line: before[i] });
			i++;
			j++;
		} else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) {
			ops.push({ kind: "remove", line: before[i] });
			i++;
		} else {
			ops.push({ kind: "add", line: after[j] });
			j++;
		}
	}
	while (i < before.length) ops.push({ kind: "remove", line: before[i++] });
	while (j < after.length) ops.push({ kind: "add", line: after[j++] });
	return ops;
}

/** Every operation between two line arrays, common edges included. */
function diffOps(before: string[], after: string[]): Op[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}

	return [
		...before.slice(0, prefix).map((line) => ({ kind: "equal", line }) as const),
		...lcsOps(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)),
		...before.slice(before.length - suffix).map((line) => ({ kind: "equal", line }) as const),
	];
}

interface Hunk {
	beforeStart: number;
	beforeCount: number;
	afterStart: number;
	afterCount: number;
	lines: string[];
}

/** Group operations into hunks, each padded with a few lines of context. */
function toHunks(ops: readonly Op[]): Hunk[] {
	const changed = ops
		.map((op, index) => (op.kind === "equal" ? -1 : index))
		.filter((index) => index !== -1);
	if (changed.length === 0) return [];

	// Runs of changes closer together than twice the context share a hunk, so the
	// context between them is not printed once as trailing and once as leading.
	const ranges: { start: number; end: number }[] = [];
	for (const index of changed) {
		const last = ranges[ranges.length - 1];
		if (last && index - last.end <= CONTEXT_LINES * 2) last.end = index;
		else ranges.push({ start: index, end: index });
	}

	const hunks: Hunk[] = [];
	let beforeLine = 1;
	let afterLine = 1;
	// Line numbers at each operation index, walked once.
	const beforeAt: number[] = [];
	const afterAt: number[] = [];
	for (const op of ops) {
		beforeAt.push(beforeLine);
		afterAt.push(afterLine);
		if (op.kind !== "add") beforeLine++;
		if (op.kind !== "remove") afterLine++;
	}

	for (const range of ranges) {
		const from = Math.max(0, range.start - CONTEXT_LINES);
		const to = Math.min(ops.length - 1, range.end + CONTEXT_LINES);
		const lines: string[] = [];
		let beforeCount = 0;
		let afterCount = 0;
		for (let index = from; index <= to; index++) {
			const op = ops[index];
			lines.push(`${op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " "}${op.line}`);
			if (op.kind !== "add") beforeCount++;
			if (op.kind !== "remove") afterCount++;
		}
		hunks.push({
			// An empty side is numbered from 0, which is what unified diff does for
			// a file that is being created or removed entirely.
			beforeStart: beforeCount === 0 ? 0 : beforeAt[from],
			beforeCount,
			afterStart: afterCount === 0 ? 0 : afterAt[from],
			afterCount,
			lines,
		});
	}
	return hunks;
}

/**
 * Diff two versions of one file.
 *
 * `before` is the file as the checkpoint has it and `after` is the file now, so
 * an addition is a line the agent added and a deletion one it removed — which is
 * the direction the review panel reads in too.
 */
export function diffLines(before: string, after: string, path = "file"): LineDiff {
	if (before === after) return { patch: "", additions: 0, deletions: 0, binary: false };
	if (looksBinary(before) || looksBinary(after)) {
		return { patch: "", additions: 0, deletions: 0, binary: true };
	}

	const ops = diffOps(splitLines(before), splitLines(after));
	let additions = 0;
	let deletions = 0;
	for (const op of ops) {
		if (op.kind === "add") additions++;
		else if (op.kind === "remove") deletions++;
	}
	if (additions === 0 && deletions === 0) {
		return { patch: "", additions: 0, deletions: 0, binary: false };
	}

	const hunks = toHunks(ops);
	const body = hunks
		.map(
			(hunk) =>
				`@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@\n${hunk.lines.join("\n")}`,
		)
		.join("\n");
	return {
		patch: `--- a/${path}\n+++ b/${path}\n${body}\n`,
		additions,
		deletions,
		binary: false,
	};
}

/** Counts alone, for a file row that does not need the patch text. */
export function countLineChanges(before: string, after: string): DiffCounts {
	const { additions, deletions } = diffLines(before, after);
	return { additions, deletions };
}
