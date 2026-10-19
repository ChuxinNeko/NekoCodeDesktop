// FILE: diff-parse.ts
// Purpose: Turn a unified diff into rows with line numbers, and pair removed and
//          added runs for the side-by-side view. Pure, so it can be tested alone.
// Layer: Renderer lib

export type DiffRowKind = "context" | "add" | "del" | "hunk" | "note" | "file";

export interface DiffRow {
	kind: DiffRowKind;
	oldNo: number | null;
	newNo: number | null;
	text: string;
}

export interface DiffMeta {
	isNew: boolean;
	isDeleted: boolean;
	isBinary: boolean;
	renameFrom: string | null;
	renameTo: string | null;
	/** `100644 → 100755`, when only the file mode changed. */
	modeChange: string | null;
}

export interface ParsedDiff {
	rows: DiffRow[];
	meta: DiffMeta;
	additions: number;
	deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseDiff(patch: string): ParsedDiff {
	const meta: DiffMeta = {
		isNew: false,
		isDeleted: false,
		isBinary: false,
		renameFrom: null,
		renameTo: null,
		modeChange: null,
	};
	const rows: DiffRow[] = [];
	let additions = 0;
	let deletions = 0;
	let oldNo = 0;
	let newNo = 0;
	let oldLeft = 0;
	let newLeft = 0;
	let sections = 0;
	let oldMode: string | null = null;
	let newMode: string | null = null;

	const lines = patch.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();

	for (const line of lines) {
		const inHunk = oldLeft > 0 || newLeft > 0;
		if (inHunk) {
			if (line.startsWith("\\")) {
				rows.push({ kind: "note", oldNo: null, newNo: null, text: line.replace(/^\\\s*/, "") });
				continue;
			}
			if (line.startsWith("+")) {
				rows.push({ kind: "add", oldNo: null, newNo: newNo, text: line.slice(1) });
				newNo += 1;
				newLeft -= 1;
				additions += 1;
				continue;
			}
			if (line.startsWith("-")) {
				rows.push({ kind: "del", oldNo: oldNo, newNo: null, text: line.slice(1) });
				oldNo += 1;
				oldLeft -= 1;
				deletions += 1;
				continue;
			}
			if (line.startsWith(" ") || line === "") {
				rows.push({ kind: "context", oldNo: oldNo, newNo: newNo, text: line.slice(1) });
				oldNo += 1;
				newNo += 1;
				oldLeft -= 1;
				newLeft -= 1;
				continue;
			}
		}
		if (line.startsWith("\\")) {
			rows.push({ kind: "note", oldNo: null, newNo: null, text: line.replace(/^\\\s*/, "") });
			continue;
		}
		const hunk = HUNK.exec(line);
		if (hunk) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[3]);
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
			rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
			continue;
		}
		if (line.startsWith("diff ")) {
			sections += 1;
			if (sections > 1) {
				const target = / b\/(.+)$/.exec(line)?.[1] ?? line;
				rows.push({ kind: "file", oldNo: null, newNo: null, text: target });
			}
			continue;
		}
		if (sections > 1) continue; // metadata of a later file: only its path row is shown
		if (line.startsWith("new file mode")) meta.isNew = true;
		else if (line.startsWith("deleted file mode")) meta.isDeleted = true;
		else if (line.startsWith("rename from ")) meta.renameFrom = line.slice(12);
		else if (line.startsWith("rename to ")) meta.renameTo = line.slice(10);
		else if (line.startsWith("old mode ")) oldMode = line.slice(9);
		else if (line.startsWith("new mode ")) newMode = line.slice(9);
		else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) meta.isBinary = true;
	}
	if (oldMode && newMode) meta.modeChange = `${oldMode} → ${newMode}`;
	return { rows, meta, additions, deletions };
}

export type SplitRow =
	| { type: "full"; row: DiffRow }
	| { type: "pair"; left: DiffRow | null; right: DiffRow | null };

/**
 * Line up the side-by-side view: a run of removed lines followed by a run of added
 * ones reads as an edit, so the n-th removal faces the n-th addition; extras face
 * a blank. Context lines face themselves.
 */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
	const out: SplitRow[] = [];
	let index = 0;
	while (index < rows.length) {
		const row = rows[index]!;
		if (row.kind === "del") {
			const removed: DiffRow[] = [];
			while (rows[index]?.kind === "del") removed.push(rows[index++]!);
			const added: DiffRow[] = [];
			while (rows[index]?.kind === "add") added.push(rows[index++]!);
			const length = Math.max(removed.length, added.length);
			for (let at = 0; at < length; at += 1) {
				out.push({ type: "pair", left: removed[at] ?? null, right: added[at] ?? null });
			}
			continue;
		}
		index += 1;
		if (row.kind === "add") out.push({ type: "pair", left: null, right: row });
		else if (row.kind === "context") out.push({ type: "pair", left: row, right: row });
		else out.push({ type: "full", row });
	}
	return out;
}

/** Longest lines worth comparing character by character. */
const INLINE_LIMIT = 400;

/**
 * The part of two paired lines that actually changed: everything between their
 * common prefix and common suffix. Null when the lines are too long to be worth
 * it or share nothing, where highlighting the whole line adds no information.
 */
export function changedSpan(
	before: string,
	after: string,
): { before: [number, number]; after: [number, number] } | null {
	if (before === after || before.length > INLINE_LIMIT || after.length > INLINE_LIMIT) return null;
	let prefix = 0;
	const shortest = Math.min(before.length, after.length);
	while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < shortest - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix += 1;
	}
	if (prefix === 0 && suffix === 0) return null;
	return {
		before: [prefix, before.length - suffix],
		after: [prefix, after.length - suffix],
	};
}

/** Pair each removed line with the added line it most plausibly became, by position within a run. */
export function pairedSpans(rows: DiffRow[]): Map<DiffRow, [number, number]> {
	const spans = new Map<DiffRow, [number, number]>();
	let index = 0;
	while (index < rows.length) {
		if (rows[index]?.kind !== "del") {
			index += 1;
			continue;
		}
		const removed: DiffRow[] = [];
		while (rows[index]?.kind === "del") removed.push(rows[index++]!);
		const added: DiffRow[] = [];
		while (rows[index]?.kind === "add") added.push(rows[index++]!);
		const count = Math.min(removed.length, added.length);
		for (let at = 0; at < count; at += 1) {
			const span = changedSpan(removed[at]!.text, added[at]!.text);
			if (!span) continue;
			spans.set(removed[at]!, span.before);
			spans.set(added[at]!, span.after);
		}
	}
	return spans;
}
