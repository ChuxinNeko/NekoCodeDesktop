import { describe, expect, test } from "bun:test";
import { nextCronOccurrence, nextOccurrence, parseCronExpression } from "./automationSchedule";

describe("parseCronExpression", () => {
	test("expands wildcards, ranges, lists, and steps", () => {
		const fields = parseCronExpression("*/15 9-11 1,15 * 1-5");
		expect([...fields.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
		expect([...fields.hours].sort((a, b) => a - b)).toEqual([9, 10, 11]);
		expect([...fields.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 15]);
		expect(fields.months.size).toBe(12);
		expect([...fields.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
	});

	test("treats a bare number with a step as start..max", () => {
		expect([...parseCronExpression("5/20 * * * *").minutes].sort((a, b) => a - b)).toEqual([
			5, 25, 45,
		]);
	});

	test("flags both day fields as restricted only when neither is a wildcard", () => {
		expect(parseCronExpression("0 0 * * 1").dayFieldsRestricted).toBe(false);
		expect(parseCronExpression("0 0 1 * *").dayFieldsRestricted).toBe(false);
		expect(parseCronExpression("0 0 1 * 1").dayFieldsRestricted).toBe(true);
	});

	test("rejects malformed expressions", () => {
		expect(() => parseCronExpression("0 0 * *")).toThrow(/5 个字段/);
		expect(() => parseCronExpression("60 0 * * *")).toThrow(/超出范围/);
		expect(() => parseCronExpression("0 0 0 * *")).toThrow(/超出范围/);
		expect(() => parseCronExpression("*/0 0 * * *")).toThrow(/步长/);
		expect(() => parseCronExpression("0 0 * * MON")).toThrow();
		expect(() => parseCronExpression("5-1 0 * * *")).toThrow(/超出范围/);
	});
});

describe("nextCronOccurrence", () => {
	test("finds the next matching minute strictly after the reference", () => {
		const from = new Date("2026-03-02T08:00:00");
		const next = nextCronOccurrence("30 9 * * *", from);
		expect(next?.toISOString()).toBe(new Date("2026-03-02T09:30:00").toISOString());
	});

	test("skips the current minute when it already matches", () => {
		const from = new Date("2026-03-02T09:30:00");
		const next = nextCronOccurrence("30 9 * * *", from);
		expect(next?.toISOString()).toBe(new Date("2026-03-03T09:30:00").toISOString());
	});

	test("rolls across month boundaries", () => {
		const next = nextCronOccurrence("0 0 1 * *", new Date("2026-01-15T12:00:00"));
		expect(next?.toISOString()).toBe(new Date("2026-02-01T00:00:00").toISOString());
	});

	test("ORs day-of-month and day-of-week when both are restricted", () => {
		// The 1st of the month OR any Monday, whichever comes first.
		const next = nextCronOccurrence("0 0 1 * 1", new Date("2026-03-02T00:30:00"));
		expect(next?.toISOString()).toBe(new Date("2026-03-09T00:00:00").toISOString());
	});

	test("returns null for an impossible expression instead of looping forever", () => {
		expect(nextCronOccurrence("0 0 30 2 *", new Date("2026-03-02T00:00:00"))).toBeNull();
	});
});

describe("nextOccurrence", () => {
	test("interval adds the configured number of minutes", () => {
		const from = new Date("2026-03-02T09:00:00");
		expect(nextOccurrence({ kind: "interval", minutes: 90 }, from)?.toISOString()).toBe(
			new Date("2026-03-02T10:30:00").toISOString(),
		);
	});

	test("daily fires later today, or tomorrow once the time has passed", () => {
		expect(
			nextOccurrence({ kind: "daily", hour: 9, minute: 30 }, new Date("2026-03-02T08:00:00"))?.toISOString(),
		).toBe(new Date("2026-03-02T09:30:00").toISOString());
		expect(
			nextOccurrence({ kind: "daily", hour: 9, minute: 30 }, new Date("2026-03-02T10:00:00"))?.toISOString(),
		).toBe(new Date("2026-03-03T09:30:00").toISOString());
	});

	test("an unparseable cron schedule yields no next run rather than throwing", () => {
		expect(nextOccurrence({ kind: "cron", expression: "nonsense" }, new Date())).toBeNull();
	});
});
