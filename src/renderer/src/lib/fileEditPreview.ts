import type { AgentCell } from "../../../shared/agent";
import { editTextLines, liveDiffCount } from "./liveDiffStats";

export type FileEditLine = { kind: "add" | "remove" | "context"; text: string };
export type FileEditPreview = { path: string; lines: FileEditLine[] };

function resultDiffLines(diff: string): FileEditLine[] {
	return diff.split("\n").map((raw) => {
		const match = /^([+\- ]) *\d+ (.*)$/.exec(raw);
		if (!match) return { kind: "context", text: raw };
		const kind = match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context";
		return { kind, text: match[2] };
	});
}

export function fileEditPreview(cell: Extract<AgentCell, { type: "tool" }>, completedLinesOnly = false): FileEditPreview | null {
	if (cell.toolName !== "edit" && cell.toolName !== "write") return null;
	const args =
		typeof cell.args === "object" && cell.args !== null
			? (cell.args as Record<string, unknown>)
			: {};
	// Models can emit edits/content before path. The tool name is enough to
	// mount the card; do not hide received code while waiting for its filename.
	const rawPath = args.path ?? args.file_path;

	let lines: FileEditLine[] = [];
	const textLines = (text: string) => editTextLines(text, completedLinesOnly && !!cell.inputStreaming);
	if (cell.toolName === "write") {
		if (typeof args.content === "string") {
			lines = textLines(args.content).map((text) => ({ kind: "add", text }));
		}
	} else {
		const details =
			typeof cell.details === "object" && cell.details !== null
				? (cell.details as Record<string, unknown>)
				: null;
		if (typeof details?.diff === "string" && details.diff) {
			lines = resultDiffLines(details.diff);
		} else {
			const edits: { oldText?: unknown; newText?: unknown }[] = [
				...(Array.isArray(args.edits) ? args.edits : []),
				...(typeof args.oldText === "string" || typeof args.newText === "string"
					? [{ oldText: args.oldText, newText: args.newText }]
					: []),
			];
			for (const edit of edits) {
				if (typeof edit !== "object" || edit === null) continue;
				if (typeof edit.oldText === "string") {
					for (const text of textLines(edit.oldText)) lines.push({ kind: "remove", text });
				}
				if (typeof edit.newText === "string") {
					for (const text of textLines(edit.newText)) lines.push({ kind: "add", text });
				}
			}
		}
	}
	return { path: typeof rawPath === "string" ? rawPath : "", lines };
}

/** Shared by stage headings and the live turn capsule, including partial inputs. */
export function fileEditStats(cell: Extract<AgentCell, { type: "tool" }>, active: boolean) {
	const preview = cell.status === "error" ? null : fileEditPreview(cell, true);
	let insertions = 0;
	let deletions = 0;
	for (const line of preview?.lines ?? []) {
		if (line.kind === "add") insertions++;
		if (line.kind === "remove") deletions++;
	}
	const live = active && cell.status !== "done";
	return { path: preview?.path ?? "", insertions: liveDiffCount(insertions, live), deletions: liveDiffCount(deletions, live) };
}
