import type { AutomationSchedule } from "./automation";

/**
 * Schedule arithmetic. Kept free of Electron and Node APIs so the cron parser and
 * the "next occurrence" search are unit-testable.
 *
 * Supported cron subset (standard 5 fields: minute hour day-of-month month day-of-week):
 *   *   any value
 *   5   a single value
 *   1-5 a range
 *   1,3,5 a list
 *   *​/15 a step over the field's range
 * Ranges, lists, and steps combine (`1-30/5`, `1,15-20`). Names (MON, JAN) and the
 * `L`/`W`/`#` extensions are not supported and are rejected at parse time.
 */

export interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
	/** True when day-of-month/day-of-week must be OR'd (standard cron rule). */
	dayFieldsRestricted: boolean;
}

const FIELD_RANGES = {
	minute: [0, 59],
	hour: [0, 23],
	dayOfMonth: [1, 31],
	month: [1, 12],
	dayOfWeek: [0, 6],
} as const;

type FieldName = keyof typeof FIELD_RANGES;

function parseField(raw: string, name: FieldName): Set<number> {
	const [min, max] = FIELD_RANGES[name];
	const values = new Set<number>();
	for (const part of raw.split(",")) {
		const segment = part.trim();
		if (segment.length === 0) throw new Error(`cron: 空的 ${name} 段`);
		const [rangePart, stepPart] = segment.split("/");
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) {
			throw new Error(`cron: ${name} 的步长无效: ${segment}`);
		}
		let start: number;
		let end: number;
		if (rangePart === "*" || rangePart === undefined) {
			start = min;
			end = max;
		} else if (rangePart.includes("-")) {
			const [fromRaw, toRaw] = rangePart.split("-");
			start = Number(fromRaw);
			end = Number(toRaw);
		} else {
			start = Number(rangePart);
			end = stepPart === undefined ? start : max;
		}
		if (!Number.isInteger(start) || !Number.isInteger(end)) {
			throw new Error(`cron: ${name} 的值无效: ${segment}`);
		}
		if (start < min || end > max || start > end) {
			throw new Error(`cron: ${name} 超出范围 ${String(min)}-${String(max)}: ${segment}`);
		}
		for (let value = start; value <= end; value += step) values.add(value);
	}
	if (values.size === 0) throw new Error(`cron: ${name} 没有任何取值`);
	return values;
}

export function parseCronExpression(expression: string): CronFields {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`cron: 需要 5 个字段（分 时 日 月 周），收到 ${String(fields.length)} 个`);
	}
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
		string,
		string,
		string,
		string,
		string,
	];
	return {
		minutes: parseField(minute, "minute"),
		hours: parseField(hour, "hour"),
		daysOfMonth: parseField(dayOfMonth, "dayOfMonth"),
		months: parseField(month, "month"),
		daysOfWeek: parseField(dayOfWeek, "dayOfWeek"),
		dayFieldsRestricted: dayOfMonth !== "*" && dayOfWeek !== "*",
	};
}

function matchesDay(fields: CronFields, date: Date): boolean {
	const dayOfMonth = fields.daysOfMonth.has(date.getDate());
	const dayOfWeek = fields.daysOfWeek.has(date.getDay());
	// Standard cron: when both day fields are restricted, either one matching fires.
	if (fields.dayFieldsRestricted) return dayOfMonth || dayOfWeek;
	return dayOfMonth && dayOfWeek;
}

/**
 * Next fire time strictly after `from`. Walks forward minute by minute, bounded to
 * roughly four years so an impossible expression (e.g. `0 0 30 2 *`) terminates.
 */
export function nextCronOccurrence(expression: string, from: Date): Date | null {
	const fields = parseCronExpression(expression);
	const candidate = new Date(from.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	const limit = 60 * 24 * 366 * 4;
	for (let step = 0; step < limit; step += 1) {
		if (
			fields.months.has(candidate.getMonth() + 1) &&
			matchesDay(fields, candidate) &&
			fields.hours.has(candidate.getHours()) &&
			fields.minutes.has(candidate.getMinutes())
		) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	return null;
}

/** Next fire time for any supported schedule, strictly after `from`. */
export function nextOccurrence(schedule: AutomationSchedule, from: Date): Date | null {
	switch (schedule.kind) {
		case "interval":
			return new Date(from.getTime() + schedule.minutes * 60_000);
		case "daily": {
			const next = new Date(from.getTime());
			next.setSeconds(0, 0);
			next.setHours(schedule.hour, schedule.minute, 0, 0);
			if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
			return next;
		}
		case "cron":
			try {
				return nextCronOccurrence(schedule.expression, from);
			} catch {
				return null;
			}
	}
}
