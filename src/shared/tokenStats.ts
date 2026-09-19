/**
 * Token accounting across every session the app has ever run.
 *
 * The main process reads the transcripts and rolls each model call up into
 * (day × provider × model × workspace) buckets; everything the panel shows —
 * totals, the cache hit rate, the contribution calendar, the breakdowns — is
 * derived from those buckets here, so the arithmetic is testable without a
 * window and the renderer never re-reads a transcript.
 *
 * Days are *local* calendar days. A calendar that bucketed by UTC would draw a
 * square on the wrong day for anyone west of Greenwich in the evening, which is
 * exactly when people work.
 */

/** Raw per-call figures, summed. Every rollup in this module carries these. */
export interface TokenCounts {
	/** Model calls, not turns: a turn is a dozen of these around tool use. */
	calls: number;
	/** Prompt tokens billed at full rate — cache traffic is counted apart. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Thinking tokens, when the provider breaks them out. A subset of `output`. */
	reasoning: number;
	/** Only what the provider actually priced; 0 means "not reported", not "free". */
	costUsd: number;
}

export interface TokenBucket extends TokenCounts {
	/** Local calendar day, `YYYY-MM-DD`. */
	date: string;
	/** The provider id as the transcript recorded it (`nekocode-…` for endpoints). */
	provider: string;
	model: string;
	cwd: string;
}

/** Tokens by local hour, per day — what the activity clock is drawn from. */
export interface TokenHourBucket {
	date: string;
	/** 0–23, local. */
	hour: number;
	tokens: number;
	calls: number;
}

export interface TokenSessionRollup extends TokenCounts {
	id: string;
	/** Absolute path of the transcript, so a row can be traced back to a file. */
	file: string;
	title: string;
	cwd: string;
	/** Scheduled runs spend tokens too, and are worth telling apart from chats. */
	kind: "session" | "automation";
	startedAt: number;
	updatedAt: number;
}

export interface TokenUsageReport {
	generatedAt: number;
	buckets: TokenBucket[];
	hours: TokenHourBucket[];
	/** Newest activity first. */
	sessions: TokenSessionRollup[];
	/** Provider id → the name the user gave that endpoint, where one is known. */
	providerLabels: Record<string, string>;
	files: { scanned: number; failed: number };
	/** Shown in the footer so a slow refresh is explicable rather than mysterious. */
	scanMs: number;
}

export const EMPTY_COUNTS: TokenCounts = {
	calls: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	costUsd: 0,
};

export function addCounts(target: TokenCounts, source: TokenCounts): void {
	target.calls += source.calls;
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.reasoning += source.reasoning;
	target.costUsd += source.costUsd;
}

export function sumCounts(items: Iterable<TokenCounts>): TokenCounts {
	const total = { ...EMPTY_COUNTS };
	for (const item of items) addCounts(total, item);
	return total;
}

/** Everything billed, cache traffic included. */
export function totalTokens(counts: TokenCounts): number {
	return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

/** The prompt side alone — full-rate input plus both kinds of cache traffic. */
export function promptTokens(counts: TokenCounts): number {
	return counts.input + counts.cacheRead + counts.cacheWrite;
}

/** Share of the prompt served from cache, or null when there was no prompt. */
export function cacheHitRate(counts: TokenCounts): number | null {
	const prompt = promptTokens(counts);
	return prompt > 0 ? counts.cacheRead / prompt : null;
}

// Calendar arithmetic ---------------------------------------------------------

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** The local calendar day an instant falls on. */
export function dayKey(timestamp: number): string {
	return dayKeyOf(new Date(timestamp));
}

export function dayKeyOf(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Midnight local on that day. Built from the parts rather than parsed, because
 * `new Date("2026-09-19")` is parsed as UTC and lands on the day before for
 * anyone behind it.
 */
export function parseDayKey(key: string): Date {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/**
 * The day `delta` days away. Goes through the Date constructor rather than
 * adding 86,400,000ms so a DST change costs an hour, not a day.
 */
export function shiftDay(key: string, delta: number): string {
	const date = parseDayKey(key);
	date.setDate(date.getDate() + delta);
	return dayKeyOf(date);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function dayDistance(from: string, to: string): number {
	const start = parseDayKey(from).getTime();
	const end = parseDayKey(to).getTime();
	return Math.round((end - start) / 86_400_000);
}

export type TokenRangeId = "7d" | "30d" | "90d" | "365d" | "all";

export const TOKEN_RANGE_DAYS: Record<Exclude<TokenRangeId, "all">, number> = {
	"7d": 7,
	"30d": 30,
	"90d": 90,
	"365d": 365,
};

/**
 * The window a range selects, as inclusive day keys. `all` has no start, which
 * callers read as "no lower bound" rather than as a date.
 */
export function rangeWindow(
	range: TokenRangeId,
	today: string,
): { start: string | null; end: string } {
	if (range === "all") return { start: null, end: today };
	return { start: shiftDay(today, -(TOKEN_RANGE_DAYS[range] - 1)), end: today };
}

/** The equally long window immediately before this one, for a period-over-period delta. */
export function previousWindow(
	range: TokenRangeId,
	today: string,
): { start: string; end: string } | null {
	if (range === "all") return null;
	const days = TOKEN_RANGE_DAYS[range];
	const end = shiftDay(today, -days);
	return { start: shiftDay(end, -(days - 1)), end };
}

export function inWindow(
	date: string,
	window: { start: string | null; end: string },
): boolean {
	if (window.start !== null && date < window.start) return false;
	return date <= window.end;
}

/** Day keys compare lexicographically because they are zero-padded — no parsing. */
export function filterBuckets<T extends { date: string }>(
	buckets: readonly T[],
	window: { start: string | null; end: string },
): T[] {
	return buckets.filter((bucket) => inWindow(bucket.date, window));
}

// Daily series ----------------------------------------------------------------

export interface TokenDay extends TokenCounts {
	date: string;
	total: number;
}

/** One entry per day that saw a call, ascending. Days with nothing are absent. */
export function dailySeries(buckets: readonly TokenBucket[]): TokenDay[] {
	const byDate = new Map<string, TokenDay>();
	for (const bucket of buckets) {
		let day = byDate.get(bucket.date);
		if (!day) {
			day = { date: bucket.date, total: 0, ...EMPTY_COUNTS };
			byDate.set(bucket.date, day);
		}
		addCounts(day, bucket);
		day.total += totalTokens(bucket);
	}
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Heat levels -----------------------------------------------------------------

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Four cut points over the days that had activity: three level boundaries and
 * the maximum, which the legend reports.
 *
 * Quartiles rather than an even split of the maximum: one all-nighter against a
 * refactor would otherwise flatten a year of ordinary days into the palest
 * square, which says the opposite of what happened. Below four distinct values
 * there is no distribution to rank, so it falls back to splitting the maximum —
 * which at least keeps the busiest day the darkest one.
 */
export function heatThresholds(values: readonly number[]): [number, number, number, number] {
	const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
	if (positive.length === 0) return [0, 0, 0, 0];
	const max = positive[positive.length - 1] ?? 0;
	if (new Set(positive).size < 4) return [max * 0.25, max * 0.5, max * 0.75, max];
	const at = (fraction: number): number =>
		positive[Math.max(0, Math.ceil(fraction * positive.length) - 1)] ?? 0;
	return [at(0.25), at(0.5), at(0.75), max];
}

export function heatLevel(
	tokens: number,
	thresholds: readonly [number, number, number, number],
): HeatLevel {
	if (tokens <= 0) return 0;
	if (tokens <= thresholds[0]) return 1;
	if (tokens <= thresholds[1]) return 2;
	if (tokens <= thresholds[2]) return 3;
	return 4;
}

// Contribution calendar -------------------------------------------------------

export interface CalendarCell {
	date: string;
	tokens: number;
	calls: number;
	costUsd: number;
	level: HeatLevel;
	/**
	 * Padding that keeps the first and last columns whole weeks. Rendered as an
	 * empty slot: a ragged column would misalign every weekday row beside it.
	 */
	filler: boolean;
}

export interface CalendarMonthLabel {
	/** Column the label sits above. */
	week: number;
	/** 0–11, so the caller can name the month in its own locale. */
	month: number;
	year: number;
}

export interface TokenCalendar {
	/** Columns of seven, oldest first; row 0 is `weekStartsOn`. */
	weeks: CalendarCell[][];
	months: CalendarMonthLabel[];
	thresholds: [number, number, number, number];
	max: number;
	tokens: number;
	activeDays: number;
	days: number;
	busiest: CalendarCell | null;
}

/**
 * Lay a day series out as a GitHub-style contribution grid.
 *
 * The window is padded outward to whole weeks so every column has seven cells;
 * the padding is marked rather than dropped, because the renderer has to leave
 * a hole there for the weekday rows to stay straight.
 */
export function buildCalendar(
	days: readonly TokenDay[],
	options: { start: string; end: string; weekStartsOn?: 0 | 1 },
): TokenCalendar {
	const weekStartsOn = options.weekStartsOn ?? 0;
	const byDate = new Map(days.map((day) => [day.date, day]));

	const startDate = parseDayKey(options.start);
	const leading = (startDate.getDay() - weekStartsOn + 7) % 7;
	const gridStart = shiftDay(options.start, -leading);
	const endDate = parseDayKey(options.end);
	const trailing = (weekStartsOn + 6 - endDate.getDay() + 7) % 7;
	const gridEnd = shiftDay(options.end, trailing);

	const windowValues: number[] = [];
	for (const day of days) {
		if (day.date >= options.start && day.date <= options.end) windowValues.push(day.total);
	}
	const thresholds = heatThresholds(windowValues);

	const weeks: CalendarCell[][] = [];
	const months: CalendarMonthLabel[] = [];
	let busiest: CalendarCell | null = null;
	let tokens = 0;
	let activeDays = 0;
	let dayCount = 0;
	let labelledMonth = -1;

	let cursor = gridStart;
	while (cursor <= gridEnd) {
		const week: CalendarCell[] = [];
		for (let index = 0; index < 7; index++) {
			const filler = cursor < options.start || cursor > options.end;
			const day = filler ? undefined : byDate.get(cursor);
			const cell: CalendarCell = {
				date: cursor,
				tokens: day?.total ?? 0,
				calls: day?.calls ?? 0,
				costUsd: day?.costUsd ?? 0,
				level: filler ? 0 : heatLevel(day?.total ?? 0, thresholds),
				filler,
			};
			if (!filler) {
				dayCount++;
				tokens += cell.tokens;
				if (cell.tokens > 0) activeDays++;
				if (!busiest || cell.tokens > busiest.tokens) busiest = cell;
			}
			week.push(cell);
			cursor = shiftDay(cursor, 1);
		}
		// Label the column where a new month opens. Keyed off the first cell so a
		// month always claims the column its first days actually sit in.
		const first = parseDayKey(week[0].date);
		if (first.getMonth() !== labelledMonth) {
			labelledMonth = first.getMonth();
			months.push({ week: weeks.length, month: first.getMonth(), year: first.getFullYear() });
		}
		weeks.push(week);
	}

	return {
		weeks,
		months,
		thresholds,
		max: busiest?.tokens ?? 0,
		tokens,
		activeDays,
		days: dayCount,
		busiest: busiest && busiest.tokens > 0 ? busiest : null,
	};
}

export interface TokenStreaks {
	/** Days in a row up to today (or yesterday — today may simply not have started). */
	current: number;
	longest: number;
	activeDays: number;
}

/**
 * Consecutive active days.
 *
 * The current streak tolerates an idle today: at 9am a streak that ran through
 * last night is still alive, and resetting it to zero every midnight would make
 * the number useless for most of the working day.
 */
export function tokenStreaks(days: readonly TokenDay[], today: string): TokenStreaks {
	const active = [...new Set(days.filter((day) => day.total > 0).map((day) => day.date))].sort();
	if (active.length === 0) return { current: 0, longest: 0, activeDays: 0 };

	let longest = 1;
	let run = 1;
	for (let index = 1; index < active.length; index++) {
		run = dayDistance(active[index - 1], active[index]) === 1 ? run + 1 : 1;
		if (run > longest) longest = run;
	}

	const last = active[active.length - 1];
	const gap = dayDistance(last, today);
	let current = 0;
	if (gap === 0 || gap === 1) {
		current = 1;
		for (let index = active.length - 1; index > 0; index--) {
			if (dayDistance(active[index - 1], active[index]) !== 1) break;
			current++;
		}
	}
	return { current, longest, activeDays: active.length };
}

// Breakdowns ------------------------------------------------------------------

export interface TokenBreakdownRow extends TokenCounts {
	key: string;
	label: string;
	total: number;
	/** Fraction of the window's tokens, for the share bar. */
	share: number;
}

/**
 * Group buckets by some dimension — model, provider, workspace — and sort by
 * what they cost, which is the order every question about them is asked in.
 */
export function breakdown(
	buckets: readonly TokenBucket[],
	select: (bucket: TokenBucket) => { key: string; label: string },
): TokenBreakdownRow[] {
	const rows = new Map<string, TokenBreakdownRow>();
	let grand = 0;
	for (const bucket of buckets) {
		const { key, label } = select(bucket);
		let row = rows.get(key);
		if (!row) {
			row = { key, label, total: 0, share: 0, ...EMPTY_COUNTS };
			rows.set(key, row);
		}
		addCounts(row, bucket);
		const total = totalTokens(bucket);
		row.total += total;
		grand += total;
	}
	return [...rows.values()]
		.map((row) => ({ ...row, share: grand > 0 ? row.total / grand : 0 }))
		.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

/**
 * Tokens by hour of the local day, as 24 slots.
 *
 * Always all 24, zeros included: the shape of a day is the point, and dropping
 * the quiet hours would compress the axis until it no longer reads as a clock.
 */
export function hourlyProfile(
	hours: readonly TokenHourBucket[],
	window: { start: string | null; end: string },
): { hour: number; tokens: number; calls: number; level: HeatLevel }[] {
	const slots = Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, calls: 0 }));
	for (const entry of hours) {
		if (!inWindow(entry.date, window)) continue;
		const slot = slots[entry.hour];
		if (!slot) continue;
		slot.tokens += entry.tokens;
		slot.calls += entry.calls;
	}
	const thresholds = heatThresholds(slots.map((slot) => slot.tokens));
	return slots.map((slot) => ({ ...slot, level: heatLevel(slot.tokens, thresholds) }));
}

// Formatting ------------------------------------------------------------------

/**
 * Three significant figures with a magnitude suffix: a tile has room for
 * "1.24M" and none for "1,238,4402".
 */
export function formatCompactTokens(value: number): string {
	const abs = Math.abs(value);
	if (abs < 1000) return String(Math.round(value));
	for (const [limit, suffix] of [
		[1e12, "T"],
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	] as const) {
		if (abs < limit) continue;
		const scaled = value / limit;
		return `${scaled.toFixed(Math.abs(scaled) < 10 ? 2 : Math.abs(scaled) < 100 ? 1 : 0)}${suffix}`;
	}
	return String(Math.round(value));
}

/** Signed share change between two periods, or null when there is nothing to compare to. */
export function percentChange(current: number, previous: number): number | null {
	if (previous <= 0) return null;
	return (current - previous) / previous;
}

export function formatSignedPercent(ratio: number): string {
	const percent = ratio * 100;
	const rounded = Math.abs(percent) >= 100 ? percent.toFixed(0) : percent.toFixed(1);
	return `${percent > 0 ? "+" : ""}${rounded}%`;
}
