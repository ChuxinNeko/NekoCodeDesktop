import type { SessionSummary } from "./agent";

/**
 * Presentation rules for the session list, kept out of the components so the
 * bucketing and the clock arithmetic can be tested directly, and so the main
 * process derives titles the exact same way the sidebar renders them.
 */

export const UNTITLED_SESSION = "New session";

/** Collapse whitespace and clip — titles and previews are always one line. */
export function normalizeLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	if (line.length <= max) return line;
	return `${line.slice(0, max - 1).trimEnd()}…`;
}

/** What a session is called: its name, else its opening prompt, else a placeholder. */
export function sessionTitle(name: string | null | undefined, firstMessage: string): string {
	const named = name?.trim();
	if (named) return normalizeLine(named, 80);
	return normalizeLine(firstMessage, 80) || UNTITLED_SESSION;
}

export type SessionBucketId = "today" | "yesterday" | "week" | "month" | "older";

export interface SessionBucket {
	id: SessionBucketId;
	label: string;
	sessions: SessionSummary[];
}

const BUCKET_ORDER: readonly SessionBucketId[] = [
	"today",
	"yesterday",
	"week",
	"month",
	"older",
];

const BUCKET_LABELS: Record<SessionBucketId, string> = {
	today: "Today",
	yesterday: "Yesterday",
	week: "Previous 7 days",
	month: "Previous 30 days",
	older: "Older",
};

const DAY_MS = 86_400_000;

function startOfDay(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * Which heading a session sits under. Boundaries are calendar days, not rolling
 * 24-hour windows: something touched at 23:55 yesterday reads as "Yesterday" all
 * of today, which is what the timestamps in the row say too.
 */
export function sessionBucket(updatedAt: number, now: number): SessionBucketId {
	const today = startOfDay(now);
	if (updatedAt >= today) return "today";
	if (updatedAt >= today - DAY_MS) return "yesterday";
	if (updatedAt >= today - 7 * DAY_MS) return "week";
	if (updatedAt >= today - 30 * DAY_MS) return "month";
	return "older";
}

/** Case-insensitive match over the text a row actually shows. */
export function sessionMatchesQuery(session: SessionSummary, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return (
		session.title.toLowerCase().includes(needle) ||
		session.preview.toLowerCase().includes(needle)
	);
}

/**
 * Filter, sort newest-first, and split into date buckets. Buckets with nothing in
 * them are dropped so the list never shows an empty heading.
 */
export function groupSessions(
	sessions: readonly SessionSummary[],
	options: { now: number; query?: string },
): SessionBucket[] {
	const matched = sessions
		.filter((session) => sessionMatchesQuery(session, options.query ?? ""))
		.sort((a, b) => b.updatedAt - a.updatedAt);

	const byBucket = new Map<SessionBucketId, SessionSummary[]>();
	for (const session of matched) {
		const id = sessionBucket(session.updatedAt, options.now);
		const bucket = byBucket.get(id);
		if (bucket) bucket.push(session);
		else byBucket.set(id, [session]);
	}

	return BUCKET_ORDER.flatMap((id) => {
		const bucketSessions = byBucket.get(id);
		if (!bucketSessions?.length) return [];
		return [{ id, label: BUCKET_LABELS[id], sessions: bucketSessions }];
	});
}

/**
 * Compact age for the right edge of a row: "now", "5m", "3h", "2d", then a date
 * once a week has passed and the day count stops being meaningful.
 */
export function relativeSessionTime(updatedAt: number, now: number): string {
	const delta = now - updatedAt;
	if (delta < 60_000) return "now";
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;

	const date = new Date(updatedAt);
	const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
	const year = date.getFullYear();
	if (year === new Date(now).getFullYear()) return monthDay;
	return `${monthDay}/${String(year).slice(2)}`;
}
