import type { AgentCell } from "./agent";

export type UserCellData = Extract<AgentCell, { type: "user" }>;
export type AssistantCellData = Extract<AgentCell, { type: "assistant" }>;
export type ToolCellData = Extract<AgentCell, { type: "tool" }>;
export type NoticeCellData = Extract<AgentCell, { type: "notice" }>;

/** One step inside a work group, in stream order. */
export type WorkItem =
	| { kind: "thinking"; id: string; cell: AssistantCellData }
	| { kind: "tool"; id: string; cell: ToolCellData }
	| { kind: "notice"; id: string; cell: NoticeCellData };

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
		else rows.push({ kind: "thinking", id: item.id, cell: item.cell });
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

/** Tool calls in the group — what a collapsed header reports it is hiding. */
export function workToolCount(row: WorkRow): number {
	return row.items.reduce((count, item) => count + (item.kind === "tool" ? 1 : 0), 0);
}
