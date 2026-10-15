import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolActivityEvent } from "./reference/core/types";

const WRITE_TOOLS = new Set(["write", "edit"]);
const MAX_FILE_BYTES = 512 * 1024;

function readText(path: string): string | null {
	try {
		if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return null;
		return readFileSync(path, "utf8");
	} catch { return null; }
}

/**
 * Records the pre-image of every file a delegated actor writes, so Lead can review
 * one compact diff instead of re-reading the workspace. Pre-images are captured on
 * `tool.started`, before the write executes; shell-made changes are not tracked.
 */
export class FusionChangeTracker {
	private readonly before = new Map<string, string | null>();
	shellUsed = false;
	constructor(private readonly cwd: string) {}
	observe(event: ToolActivityEvent): void {
		if (event.type !== "started") return;
		if (event.toolName === "bash") { this.shellUsed = true; return; }
		if (!WRITE_TOOLS.has(event.toolName)) return;
		const raw = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof raw !== "string" || !raw.trim()) return;
		const path = isAbsolute(raw) ? raw : resolve(this.cwd, raw);
		if (!this.before.has(path)) this.before.set(path, readText(path));
	}
	get files(): string[] { return [...this.before.keys()].map(path => relative(this.cwd, path) || path); }
	/** Unified diff of all tracked files against their first pre-image, capped at maxChars. */
	diff(maxChars = 60000): { text: string; truncated: boolean; changedFiles: string[] } {
		const parts: string[] = []; const changedFiles: string[] = [];
		for (const [path, original] of this.before) {
			const current = readText(path);
			if (current === original) continue;
			const name = relative(this.cwd, path) || path;
			changedFiles.push(name);
			parts.push(unifiedDiff(name, original, current));
		}
		const text = parts.join("\n");
		if (text.length <= maxChars) return { text, truncated: false, changedFiles };
		return { text: text.slice(0, maxChars) + `\n… diff truncated (${text.length - maxChars} more characters); read the files listed above as needed.`,
			truncated: true, changedFiles };
	}
}

/** Small LCS diff with three lines of context; falls back to whole-file output for very large edits. */
export function unifiedDiff(name: string, before: string | null, after: string | null): string {
	if (before === null && after === null) return `--- ${name}\n(unreadable or larger than ${MAX_FILE_BYTES} bytes)`;
	if (before === null) return `--- /dev/null\n+++ ${name} (new file)\n${after!.split("\n").map(line => "+" + line).join("\n")}`;
	if (after === null) return `--- ${name}\n+++ /dev/null (deleted)`;
	const a = before.split("\n"), b = after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length, endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
	const midA = a.slice(start, endA), midB = b.slice(start, endB);
	const ops: Array<[" " | "-" | "+", string]> = [];
	if (midA.length * midB.length > 4_000_000) {
		for (const line of midA) ops.push(["-", line]);
		for (const line of midB) ops.push(["+", line]);
	} else {
		const n = midA.length, m = midB.length, width = m + 1;
		const table = new Uint32Array((n + 1) * width);
		for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
			table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		let i = 0, j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && midA[i] === midB[j]) { ops.push([" ", midA[i]]); i++; j++; }
			else if (j < m && (i === n || table[i * width + j + 1] >= table[(i + 1) * width + j])) { ops.push(["+", midB[j]]); j++; }
			else { ops.push(["-", midA[i]]); i++; }
		}
	}
	const context = 3;
	const lead = a.slice(Math.max(0, start - context), start).map(line => [" ", line] as [" ", string]);
	const tail = a.slice(endA, Math.min(a.length, endA + context)).map(line => [" ", line] as [" ", string]);
	const body = [...lead, ...ops, ...tail];
	// Collapse long unchanged runs inside the hunk.
	const out: string[] = []; let run: string[] = [];
	const flush = (final: boolean) => {
		if (run.length > context * 2 + 1 && !final) out.push(...run.slice(0, context), ` … ${run.length - context * 2} unchanged lines`, ...run.slice(-context));
		else out.push(...run);
		run = [];
	};
	for (const [op, line] of body) { if (op === " ") run.push(" " + line); else { flush(false); out.push(op + line); } }
	flush(true);
	return `--- ${name}\n+++ ${name}\n@@ -${Math.max(1, start - context + 1)} @@\n${out.join("\n")}`;
}
