import type { AgentCell } from "./agent";

/** Count before remote payloads are clipped. No source text is sent in this hint. */
export function toolChangeStats(cell: Extract<AgentCell, { type: "tool" }>): { insertions: number; deletions: number } | undefined {
	if (!["edit", "write"].includes(cell.toolName)) return undefined;
	if (cell.status === "error") return { insertions: 0, deletions: 0 };
	const args = typeof cell.args === "object" && cell.args !== null ? cell.args as Record<string, unknown> : {};
	const lines = (value: unknown) => {
		if (typeof value !== "string") return 0;
		const values = value.replace(/\r\n/g, "\n").split("\n");
		if (cell.inputStreaming || values.at(-1) === "") values.pop();
		return values.length;
	};
	if (cell.toolName === "write") return { insertions: lines(args.content), deletions: 0 };
	const details = typeof cell.details === "object" && cell.details !== null ? cell.details as Record<string, unknown> : {};
	if (typeof details.diff === "string" && details.diff) {
		let insertions = 0, deletions = 0;
		for (const line of details.diff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
			if (line.startsWith("-") && !line.startsWith("---")) deletions++;
		}
		return { insertions, deletions };
	}
	const edits = [...(Array.isArray(args.edits) ? args.edits : []),
		...(typeof args.oldText === "string" || typeof args.newText === "string" ? [args] : [])];
	let insertions = 0, deletions = 0;
	for (const edit of edits) {
		if (typeof edit !== "object" || edit === null) continue;
		insertions += lines(edit.newText);
		deletions += lines(edit.oldText);
	}
	return { insertions, deletions };
}
