import type { AgentCell } from "../../../shared/agent";

export interface TimelineEntry {
	id: string;
	/** One-line preview of the prompt, markdown punctuation removed. */
	preview: string;
	timestamp: number;
}

const PREVIEW_LENGTH = 80;

/** One-line, markdown-free preview; image/file placeholders keep their meaning. */
export function timelinePreview(text: string): string {
	const plain = text
		.replace(/```[\s\S]*?```/g, " [code] ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " [image] ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[`*_>#~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > PREVIEW_LENGTH ? plain.slice(0, PREVIEW_LENGTH - 1) + "…" : plain;
}

/** The user's own prompts, in transcript order: the stops on the timeline. */
export function timelineEntries(cells: readonly AgentCell[]): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	for (const cell of cells) {
		if (cell.type !== "user") continue;
		entries.push({ id: cell.id, preview: timelinePreview(cell.text), timestamp: cell.timestamp });
	}
	return entries;
}

/**
 * The prompt the reader is in: the last one whose top has passed the reading
 * line (a third down the viewport). Before the first prompt, the first is current.
 * `tops` are offsets in the scroll content, ascending.
 */
export function activeTimelineIndex(tops: readonly number[], scrollTop: number, viewportHeight: number): number {
	if (!tops.length) return -1;
	const line = scrollTop + viewportHeight / 3;
	let active = 0;
	for (let i = 0; i < tops.length; i++) {
		if (tops[i] <= line) active = i;
		else break;
	}
	return active;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** HH:mm today, MM-DD HH:mm this year, YYYY-MM-DD HH:mm otherwise. */
export function timelineTime(timestamp: number, now = Date.now()): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
	const date = new Date(timestamp);
	const today = new Date(now);
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (date.toDateString() === today.toDateString()) return time;
	const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
}
