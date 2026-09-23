import type { AgentCell, AgentSnapshot } from "../shared/agent";

/** Cells a remote client gets when it does not say how far back it already is. */
export const REMOTE_WINDOW = 60;
/** Most one request may extend the window backwards. */
export const REMOTE_WINDOW_STEP = 60;
/** Largest string a remote transcript carries inline, per field. */
export const REMOTE_FIELD_LIMIT = 4096;
/**
 * Most one response may spend on cells the client does not already hold.
 *
 * The per-field trim alone is not a bound: one cell can carry many oversized
 * fields, and sixty of those still overrun the relay's 1 MB frame. This caps
 * what a first load — or one "load earlier" step — can cost no matter how the
 * cells are shaped, at roughly half the frame limit once base64 is counted.
 */
export const REMOTE_NEW_BUDGET = 384 * 1024;
/** How deep into a tool's arguments the trim walks before giving up. */
const MAX_DEPTH = 6;

/**
 * The bounds one kind of client reads a transcript under.
 *
 * The phone and the desktop window take the same shape of view — a tail that
 * grows backwards on request, with oversized tool payloads cut to a head —
 * and differ only in how much they can afford: a relay frame on one side, a
 * render on the other.
 */
export interface TranscriptViewLimits {
	/** Cells sent when the client does not say how far back it already is. */
	window: number;
	/** Most one request may extend the window backwards. */
	step: number;
	/** Largest string carried inline, per field. */
	fieldLimit: number;
	/** Most one response may spend on cells the client does not already hold. */
	budget: number;
	/** What stands in for the part of a field that was cut. */
	omitted: (dropped: number) => string;
}

function sizeLabel(dropped: number): string {
	return dropped >= 1024 ? `${(dropped / 1024).toFixed(0)} KB` : `${String(dropped)} 字符`;
}

export const REMOTE_LIMITS: TranscriptViewLimits = {
	window: REMOTE_WINDOW,
	step: REMOTE_WINDOW_STEP,
	fieldLimit: REMOTE_FIELD_LIMIT,
	budget: REMOTE_NEW_BUDGET,
	omitted: (dropped) => `\n…（另有 ${sizeLabel(dropped)} 未传输，请在电脑端查看完整内容）`,
};

/**
 * The desktop window's view: what it mounts on open is bounded by what is on
 * screen, not by how long the session has run. Wider than the phone's, since
 * nothing here crosses a network, but still a bound — every cell sent is a
 * cell rendered.
 */
export const DESKTOP_LIMITS: TranscriptViewLimits = {
	window: 80,
	step: 80,
	fieldLimit: 16 * 1024,
	budget: 1024 * 1024,
	omitted: (dropped) => `\n…（另有 ${sizeLabel(dropped)} 未显示）`,
};

export interface RemoteViewRequest {
	/** Earliest cell the client already holds; the window starts there. */
	from?: string;
	/** Extend the window this many cells further back. */
	back?: number;
}

export interface RemoteView {
	snapshot: AgentSnapshot;
	/** There are older cells before the window starts. */
	more: boolean;
	/** How many: the index of the window's first cell in the whole transcript. */
	earlier: number;
}

/** Most of a trimmed tool result one fetch returns. */
export const REMOTE_OUTPUT_CHUNK = 256 * 1024;

export interface RemoteToolOutput {
	/** The slice starting at the requested offset. */
	text: string;
	offset: number;
	/** Length of the whole result, so the caller knows what is left. */
	total: number;
}

/**
 * One chunk of a tool result, for a client whose transcript only has the head
 * of it. Paged rather than sent whole: a single `read` of a large file can be
 * megabytes, which no relay frame will carry.
 */
export function remoteToolOutput(
	snapshot: AgentSnapshot,
	toolCallId: string,
	offset: number,
): RemoteToolOutput | null {
	for (const cell of snapshot.cells) {
		if (cell.type !== "tool" || cell.toolCallId !== toolCallId) continue;
		const start = Math.min(Math.max(offset, 0), cell.output.length);
		return {
			text: cell.output.slice(start, start + REMOTE_OUTPUT_CHUNK),
			offset: start,
			total: cell.output.length,
		};
	}
	return null;
}

function trimText(value: string, limits: TranscriptViewLimits): string {
	if (value.length <= limits.fieldLimit) return value;
	return value.slice(0, limits.fieldLimit) + limits.omitted(value.length - limits.fieldLimit);
}

/**
 * Trim every oversized string inside a tool's arguments or result details.
 *
 * Walked generically rather than per tool: `content`, `diff`, `edits[].newText`
 * and whatever the next tool names its payload all cost the same bandwidth, and
 * a list of field names would only be right until someone adds a tool.
 */
function trimValue(value: unknown, limits: TranscriptViewLimits, depth = 0): unknown {
	if (typeof value === "string") return trimText(value, limits);
	if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) return value.map((item) => trimValue(item, limits, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = trimValue(item, limits, depth + 1);
	return out;
}

function trimCell(cell: AgentCell, limits: TranscriptViewLimits): AgentCell {
	// Only tool payloads. An assistant message is the thing the user opened the
	// session to read; truncating that to save bytes trades away the point.
	if (cell.type !== "tool") return cell;
	// `task` results are a JSON control payload the transcript parses to find the
	// worker a row started — a truncated one parses to nothing.
	if (cell.toolName === "task") return cell;
	const trimmed: AgentCell = { ...cell, args: trimValue(cell.args, limits) };
	if (cell.details !== undefined) trimmed.details = trimValue(cell.details, limits);
	// The output keeps a clean prefix and a length instead of an inline marker:
	// it is the one field with a way to fetch the rest, and appending a chunk to
	// a prefix beats splicing it around a notice.
	if (cell.output.length > limits.fieldLimit) {
		trimmed.output = cell.output.slice(0, limits.fieldLimit);
		trimmed.outputTotal = cell.output.length;
	}
	return trimmed;
}

/**
 * The slice of a transcript worth sending to a client — the phone by default,
 * the desktop window under {@link DESKTOP_LIMITS}.
 *
 * Two independent bounds, because either alone still lets the first load run
 * away: a window keeps a thousand-turn session from arriving at once, and the
 * per-field trim keeps one `read` of a large file from blowing past the relay's
 * frame limit on its own.
 */
export function remoteView(
	snapshot: AgentSnapshot,
	request: RemoteViewRequest = {},
	limits: TranscriptViewLimits = REMOTE_LIMITS,
): RemoteView {
	const cells = snapshot.cells;
	const held = request.from ? cells.findIndex((cell) => cell.id === request.from) : -1;
	// An unknown `from` means a rewind dropped the cell the client was anchored
	// to. The tail is the one window that always exists.
	const anchor = held === -1 ? Math.max(0, cells.length - limits.window) : held;
	const back = Math.min(Math.max(request.back ?? 0, 0), limits.step);
	const offset = Math.max(0, anchor - back);
	const trimmed = cells.slice(offset).map((cell) => trimCell(cell, limits));
	// Everything before the cell the client is anchored to is new to it, and a
	// client that holds nothing is new to all of it. A plain poll brings none, so
	// its window is never clipped and the user keeps what they scrolled back to.
	const newest = (held === -1 ? cells.length : anchor) - 1;
	let start = newest + 1;
	let spent = 0;
	for (let i = newest; i >= offset; i--) {
		spent += JSON.stringify(trimmed[i - offset]).length;
		// One cell always goes, or a single oversized turn would be unreachable.
		if (spent > limits.budget && i < newest) break;
		start = i;
	}
	return {
		snapshot: { ...snapshot, cells: trimmed.slice(start - offset) },
		more: start > 0,
		earlier: start,
	};
}
