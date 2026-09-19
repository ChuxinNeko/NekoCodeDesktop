import { describe, expect, test } from "bun:test";
import {
	breakdown,
	buildCalendar,
	cacheHitRate,
	dailySeries,
	dayDistance,
	formatCompactTokens,
	formatSignedPercent,
	heatLevel,
	heatThresholds,
	hourlyProfile,
	percentChange,
	previousWindow,
	rangeWindow,
	shiftDay,
	sumCounts,
	tokenStreaks,
	totalTokens,
	type TokenBucket,
} from "./tokenStats";

function bucket(patch: Partial<TokenBucket> = {}): TokenBucket {
	return {
		date: "2026-09-19",
		provider: "anthropic",
		model: "claude-opus-4-8",
		cwd: "/work/app",
		calls: 1,
		input: 100,
		output: 50,
		cacheRead: 300,
		cacheWrite: 100,
		reasoning: 10,
		costUsd: 0.01,
		...patch,
	};
}

describe("counts", () => {
	test("totals bill cache traffic alongside input and output", () => {
		expect(totalTokens(bucket())).toBe(550);
	});

	test("the hit rate is the cache's share of the prompt, not of the total", () => {
		// 300 of (100 input + 300 read + 100 write) = 60%; the 50 output tokens
		// are not part of the prompt and must not dilute it.
		expect(cacheHitRate(bucket())).toBe(0.6);
		expect(cacheHitRate(bucket({ input: 0, cacheRead: 0, cacheWrite: 0 }))).toBeNull();
	});

	test("summing keeps every column apart", () => {
		const total = sumCounts([bucket(), bucket({ output: 10, calls: 2 })]);
		expect(total).toMatchObject({ calls: 3, input: 200, output: 60, cacheRead: 600 });
		expect(total.costUsd).toBeCloseTo(0.02, 10);
	});
});

describe("calendar arithmetic", () => {
	test("day maths crosses months and years", () => {
		expect(shiftDay("2026-09-19", 1)).toBe("2026-09-20");
		expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
		expect(shiftDay("2026-02-28", 1)).toBe("2026-03-01");
		expect(dayDistance("2025-12-31", "2026-01-02")).toBe(2);
		expect(dayDistance("2026-01-02", "2025-12-31")).toBe(-2);
	});

	test("a range window is inclusive on both ends", () => {
		expect(rangeWindow("7d", "2026-09-19")).toEqual({
			start: "2026-09-13",
			end: "2026-09-19",
		});
		expect(rangeWindow("all", "2026-09-19").start).toBeNull();
	});

	test("the comparison window is the same length, immediately before", () => {
		expect(previousWindow("7d", "2026-09-19")).toEqual({
			start: "2026-09-06",
			end: "2026-09-12",
		});
		expect(previousWindow("all", "2026-09-19")).toBeNull();
	});
});

describe("heat levels", () => {
	test("quartiles put the busiest day at the top level and the quietest at the bottom", () => {
		const thresholds = heatThresholds([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(heatLevel(1, thresholds)).toBe(1);
		expect(heatLevel(4, thresholds)).toBe(2);
		expect(heatLevel(6, thresholds)).toBe(3);
		expect(heatLevel(8, thresholds)).toBe(4);
	});

	test("an idle day is level zero, whatever the distribution", () => {
		expect(heatLevel(0, heatThresholds([5, 9]))).toBe(0);
		expect(heatThresholds([])).toEqual([0, 0, 0, 0]);
	});

	test("too few distinct days to rank falls back to splitting the maximum", () => {
		// With one active day quartiles are undefined — and calling the only day
		// on the calendar the palest shade would read as "barely used".
		const thresholds = heatThresholds([1000]);
		expect(heatLevel(1000, thresholds)).toBe(4);
		expect(heatLevel(200, thresholds)).toBe(1);
	});
});

describe("buildCalendar", () => {
	const days = dailySeries([
		bucket({ date: "2026-09-14", input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }),
		bucket({ date: "2026-09-16", input: 4000, output: 0, cacheRead: 0, cacheWrite: 0 }),
		bucket({ date: "2026-09-19", input: 200, output: 0, cacheRead: 0, cacheWrite: 0 }),
	]);

	test("pads the window out to whole weeks and marks the padding", () => {
		// 2026-09-14 is a Monday, 2026-09-19 a Saturday.
		const calendar = buildCalendar(days, { start: "2026-09-14", end: "2026-09-19" });
		expect(calendar.weeks).toHaveLength(1);
		expect(calendar.weeks[0]).toHaveLength(7);
		expect(calendar.weeks[0][0]).toMatchObject({ date: "2026-09-13", filler: true });
		expect(calendar.weeks[0][1]).toMatchObject({ date: "2026-09-14", filler: false });
		expect(calendar.weeks[0][6]).toMatchObject({ date: "2026-09-19", filler: false });
	});

	test("padding carries no tokens into the totals", () => {
		const calendar = buildCalendar(days, { start: "2026-09-14", end: "2026-09-19" });
		expect(calendar.days).toBe(6);
		expect(calendar.tokens).toBe(5200);
		expect(calendar.activeDays).toBe(3);
		expect(calendar.busiest?.date).toBe("2026-09-16");
	});

	test("weeks can start on Monday for locales that read them that way", () => {
		const calendar = buildCalendar(days, {
			start: "2026-09-14",
			end: "2026-09-19",
			weekStartsOn: 1,
		});
		expect(calendar.weeks[0][0]).toMatchObject({ date: "2026-09-14", filler: false });
	});

	test("labels the column each month opens in", () => {
		const calendar = buildCalendar([], { start: "2026-08-01", end: "2026-10-05" });
		const months = calendar.months.map((entry) => entry.month);
		expect(months).toEqual([6, 7, 8, 9]);
		expect(calendar.months[0].week).toBe(0);
	});

	test("an empty window still renders a grid rather than nothing", () => {
		const calendar = buildCalendar([], { start: "2026-09-14", end: "2026-09-19" });
		expect(calendar.weeks[0].every((cell) => cell.level === 0)).toBe(true);
		expect(calendar.busiest).toBeNull();
		expect(calendar.max).toBe(0);
	});
});

describe("tokenStreaks", () => {
	const day = (date: string, total: number) =>
		dailySeries([
			bucket({ date, input: total, output: 0, cacheRead: 0, cacheWrite: 0 }),
		])[0];

	test("counts consecutive active days and the longest run", () => {
		const days = [
			day("2026-09-10", 10),
			day("2026-09-11", 10),
			day("2026-09-12", 10),
			day("2026-09-17", 10),
			day("2026-09-18", 10),
			day("2026-09-19", 10),
		];
		const streaks = tokenStreaks(days, "2026-09-19");
		expect(streaks).toEqual({ current: 3, longest: 3, activeDays: 6 });
	});

	test("an idle today does not end a streak that ran through last night", () => {
		const days = [day("2026-09-18", 10), day("2026-09-19", 10)];
		expect(tokenStreaks(days, "2026-09-20").current).toBe(2);
		expect(tokenStreaks(days, "2026-09-21").current).toBe(0);
	});

	test("no activity is no streak", () => {
		expect(tokenStreaks([], "2026-09-19")).toEqual({ current: 0, longest: 0, activeDays: 0 });
	});
});

describe("breakdown", () => {
	test("groups by the chosen dimension, biggest spender first, with shares", () => {
		const rows = breakdown(
			[
				bucket({ model: "a", input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }),
				bucket({ model: "b", input: 300, output: 0, cacheRead: 0, cacheWrite: 0 }),
				bucket({ model: "a", input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }),
			],
			(entry) => ({ key: entry.model, label: entry.model }),
		);
		expect(rows.map((row) => row.key)).toEqual(["b", "a"]);
		expect(rows[0]).toMatchObject({ total: 300, share: 0.6, calls: 1 });
		expect(rows[1]).toMatchObject({ total: 200, share: 0.4, calls: 2 });
	});

	test("nothing in means no rows, not a row of zeroes", () => {
		expect(breakdown([], (entry) => ({ key: entry.model, label: entry.model }))).toEqual([]);
	});
});

describe("hourlyProfile", () => {
	test("always reports all 24 slots so the shape of a day survives", () => {
		const profile = hourlyProfile(
			[
				{ date: "2026-09-19", hour: 9, tokens: 500, calls: 2 },
				{ date: "2026-09-19", hour: 22, tokens: 100, calls: 1 },
				{ date: "2026-08-01", hour: 3, tokens: 9000, calls: 9 },
			],
			{ start: "2026-09-13", end: "2026-09-19" },
		);
		expect(profile).toHaveLength(24);
		expect(profile[9]).toMatchObject({ tokens: 500, calls: 2 });
		expect(profile[3].tokens).toBe(0);
		expect(profile[9].level).toBe(4);
		expect(profile[0].level).toBe(0);
	});
});

describe("formatting", () => {
	test("compacts by magnitude and keeps three significant figures", () => {
		expect(formatCompactTokens(742)).toBe("742");
		expect(formatCompactTokens(1234)).toBe("1.23K");
		expect(formatCompactTokens(12_345)).toBe("12.3K");
		expect(formatCompactTokens(123_456)).toBe("123K");
		expect(formatCompactTokens(1_238_000)).toBe("1.24M");
	});

	test("a change against nothing is not a change of infinity", () => {
		expect(percentChange(100, 0)).toBeNull();
		expect(percentChange(150, 100)).toBeCloseTo(0.5, 10);
		expect(formatSignedPercent(0.5)).toBe("+50.0%");
		expect(formatSignedPercent(-0.123)).toBe("-12.3%");
	});
});
