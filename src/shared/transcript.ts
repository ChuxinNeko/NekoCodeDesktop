import type { AgentCell } from "./agent";

export type UserCellData = Extract<AgentCell, { type: "user" }>;
export type AssistantCellData = Extract<AgentCell, { type: "assistant" }>;
export type ToolCellData = Extract<AgentCell, { type: "tool" }>;
export type NoticeCellData = Extract<AgentCell, { type: "notice" }>;

/** One step inside a work group, in stream order. */
export type WorkItem =
	| { kind: "thinking"; id: string; cell: AssistantCellData }
	| { kind: "tool"; id: string; cell: ToolCellData }
	| { kind: "notice"; id: string; cell: NoticeCellData }
	/** A remark made on the way, folded in once the turn's real answer has landed. */
	| { kind: "message"; id: string; cell: AssistantCellData };

/**
 * A run of reasoning and tool calls between two things the user reads: the
 * prompt that started it and the answer it produced.
 *
 * `startedAt`/`endedAt` are wall-clock epoch ms spanning the whole run, taken
 * from the cells themselves rather than measured here so a reopened session
 * reports the same span the live one did. `endedAt` on a group that is still
 * running is only as current as its newest cell — the caller that knows the
 * turn is streaming should count from `startedAt` against the clock instead.
 */
export interface WorkRow {
	kind: "work";
	id: string;
	items: WorkItem[];
	startedAt: number;
	endedAt: number;
}

/**
 * The transcript as it is read: the user's prompts and the model's answers at
 * the top level, with everything the model did in between folded into a work
 * group that can be collapsed out of the way.
 */
export type TranscriptRow =
	| { kind: "user"; id: string; cell: UserCellData }
	| { kind: "message"; id: string; cell: AssistantCellData }
	| { kind: "thinking"; id: string; cell: AssistantCellData }
	| { kind: "notice"; id: string; cell: NoticeCellData }
	| WorkRow;

/** When the model started this step. Tool cells carry their own start. */
function itemStart(cell: AgentCell): number {
	switch (cell.type) {
		case "assistant":
			return cell.thinkingStartedAt ?? cell.timestamp;
		case "tool":
			return cell.startedAt ?? cell.timestamp;
		default:
			return cell.timestamp;
	}
}

/** When it finished. A tool cell's timestamp moves to its result when one lands. */
function itemEnd(cell: AgentCell): number {
	switch (cell.type) {
		case "assistant":
			return cell.thinkingEndedAt ?? cell.timestamp;
		default:
			return cell.timestamp;
	}
}

/**
 * A group that called no tool, as its bare contents — or null when it did call
 * one and so earns its wrapper.
 */
function unwrapped(row: WorkRow): TranscriptRow[] | null {
	const rows: TranscriptRow[] = [];
	for (const item of row.items) {
		if (item.kind === "tool") return null;
		if (item.kind === "notice") rows.push({ kind: "notice", id: item.id, cell: item.cell });
		else rows.push({ kind: item.kind, id: item.id, cell: item.cell });
	}
	return rows;
}

/**
 * Fold cells into rows.
 *
 * The rule the whole transcript hangs off: prose the user reads stays at the
 * top level, and the reasoning and tool traffic that produced it goes inside a
 * work group. One assistant cell can be both — its thinking joins the group and
 * its text closes the group and lands under it.
 *
 * Groups that never called a tool are unwrapped again: a turn that only thought
 * before answering already reads as one collapsible block, and wrapping that in
 * a second one adds a level that says nothing.
 */
export function groupTranscriptRows(cells: readonly AgentCell[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	let open: WorkRow | null = null;
	// Identify a group by its place in the turn, not by the cell that opened it:
	// that cell is the streaming overlay message, whose id changes the moment it
	// is persisted — and a group whose key changes loses the user's collapse.
	let turn = "start";
	let seq = 0;

	function add(item: WorkItem, startedAt: number, endedAt: number): void {
		let row = open;
		if (row === null) {
			row = { kind: "work", id: `work-${turn}-${seq++}`, items: [], startedAt, endedAt };
			rows.push(row);
			open = row;
		}
		row.items.push(item);
		row.startedAt = Math.min(row.startedAt, startedAt);
		row.endedAt = Math.max(row.endedAt, endedAt);
	}

	/** Close the group, stretching it to the moment the work actually stopped. */
	function close(endedAt?: number): void {
		if (open !== null && endedAt !== undefined) {
			open.endedAt = Math.max(open.endedAt, endedAt);
		}
		open = null;
	}

	for (const cell of cells) {
		switch (cell.type) {
			case "user":
				close();
				turn = cell.id;
				seq = 0;
				rows.push({ kind: "user", id: cell.id, cell });
				break;
			case "notice":
				// A notice mid-run ("Compacting context…") is part of the work; one
				// standing on its own is not, and must not open a group by itself.
				if (open !== null) {
					add({ kind: "notice", id: cell.id, cell }, cell.timestamp, cell.timestamp);
				} else {
					rows.push({ kind: "notice", id: cell.id, cell });
				}
				break;
			case "tool":
				add({ kind: "tool", id: cell.id, cell }, itemStart(cell), itemEnd(cell));
				break;
			case "assistant": {
				if (cell.thinking) {
					add(
						{ kind: "thinking", id: `${cell.id}-thinking`, cell },
						itemStart(cell),
						itemEnd(cell),
					);
				}
				if (cell.text || cell.error || cell.usage) {
					// Work stopped when this message left off thinking and started
					// speaking — which, for a message that never thought, is when the
					// model call that wrote it began.
					close(itemEnd(cell));
					rows.push({ kind: "message", id: `${cell.id}-message`, cell });
				}
				break;
			}
		}
	}

	return rows.flatMap((row) => (row.kind === "work" ? (unwrapped(row) ?? [row]) : [row]));
}

/**
 * Fold each finished turn's whole process — every work group, and the remarks
 * made between them ("Let me check the config…") — into one group above the
 * reply that concludes it.
 *
 * While a turn runs its steps stay where they landed, since watching them is
 * the point. Once it is over only the conclusion is still being read, and an
 * agent that talks between tool calls otherwise leaves it as one more paragraph
 * in a long run of them. The folded group takes a key of its own, so it mounts
 * fresh — collapsed — rather than inheriting the open state of the live group.
 *
 * A turn that ends without a reply (aborted, or failed mid-tool) is left as it
 * is: there is no conclusion to set apart, and where it stopped is the news.
 * So is one that called no tool: its reasoning already folds on its own.
 */
export function foldSettledTurns(rows: readonly TranscriptRow[], streaming: boolean): TranscriptRow[] {
	const out: TranscriptRow[] = [];
	let turn = "start";
	let start = 0;

	function flush(end: number, settled: boolean): void {
		const segment = rows.slice(start, end);
		const reply = segment[segment.length - 1];
		const process = segment.slice(0, -1);
		if (!settled || reply?.kind !== "message" || !process.some((row) => row.kind === "work")) {
			out.push(...segment);
			return;
		}
		const folded: WorkRow = {
			kind: "work",
			id: `turn-${turn}`,
			items: [],
			startedAt: Number.POSITIVE_INFINITY,
			endedAt: itemEnd(reply.cell),
		};
		for (const row of process) {
			if (row.kind === "user") continue;
			if (row.kind === "work") {
				folded.items.push(...row.items);
				folded.startedAt = Math.min(folded.startedAt, row.startedAt);
				folded.endedAt = Math.max(folded.endedAt, row.endedAt);
				continue;
			}
			folded.items.push(
				row.kind === "notice"
					? { kind: "notice", id: row.id, cell: row.cell }
					: { kind: row.kind, id: row.id, cell: row.cell },
			);
			folded.startedAt = Math.min(folded.startedAt, itemStart(row.cell));
		}
		out.push(folded, reply);
	}

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.kind !== "user") continue;
		flush(i, true);
		out.push(row);
		turn = row.id;
		start = i + 1;
	}
	flush(rows.length, !streaming);
	return out;
}

/** Tool calls in the group — what a collapsed header reports it is hiding. */
export function workToolCount(row: WorkRow): number {
	return row.items.reduce((count, item) => count + (item.kind === "tool" ? 1 : 0), 0);
}

/**
 * Keep the live turn's process under the same header even when a model speaks
 * between calls. A trailing answer still streams at the top level; if a later
 * tool arrives that remark joins the timeline. Completed turns use the same key.
 */
export function foldWorkTimelineRows(rows: readonly TranscriptRow[], streaming: boolean): TranscriptRow[] {
	const folded = foldSettledTurns(rows, streaming);
	if (!streaming) return folded;
	let start = 0;
	let turn = "start";
	for (let i = 0; i < folded.length; i++) {
		const row = folded[i];
		if (row.kind === "user") { start = i + 1; turn = row.cell.id; }
	}
	const segment = folded.slice(start);
	const reply = segment[segment.length - 1];
	const hasReply = reply?.kind === "message";
	const process = hasReply ? segment.slice(0, -1) : segment;
	if (!process.some((row) => row.kind === "work" || row.kind === "thinking")) return folded;
	const work: WorkRow = { kind: "work", id: `turn-${turn}`, items: [], startedAt: Infinity, endedAt: 0 };
	for (const row of process) {
		if (row.kind === "user") continue;
		if (row.kind === "work") {
			work.items.push(...row.items);
			work.startedAt = Math.min(work.startedAt, row.startedAt);
			work.endedAt = Math.max(work.endedAt, row.endedAt);
		} else {
			work.items.push({ kind: row.kind, id: row.id, cell: row.cell } as WorkItem);
			work.startedAt = Math.min(work.startedAt, itemStart(row.cell));
			work.endedAt = Math.max(work.endedAt, itemEnd(row.cell));
		}
	}
	return [...folded.slice(0, start), work, ...(hasReply ? [reply] : [])];
}
