import { describe, expect, test } from "bun:test";
import type { TokenBucket, TokenUsageReport } from "../shared/tokenStats";
import { tokenUsageCsv } from "./token-usage-export";

function bucket(patch: Partial<TokenBucket> = {}): TokenBucket {
	return {
		date: "2026-09-19",
		provider: "nekocode-1",
		model: "glm-5.3",
		cwd: "D:\\work\\app",
		calls: 2,
		input: 1000,
		output: 500,
		cacheRead: 3000,
		cacheWrite: 1000,
		reasoning: 120,
		costUsd: 0.25,
		...patch,
	};
}

function report(buckets: TokenBucket[]): TokenUsageReport {
	return {
		generatedAt: 0,
		buckets,
		hours: [],
		sessions: [],
		providerLabels: { "nekocode-1": "Z.ai" },
		files: { scanned: 1, failed: 0 },
		scanMs: 1,
	};
}

describe("tokenUsageCsv", () => {
	test("writes a header and one row per bucket", () => {
		const lines = tokenUsageCsv(report([bucket(), bucket({ date: "2026-09-20" })]))
			.trim()
			.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toStartWith('"date","provider","provider_name"');
		expect(lines[1]).toContain('"2026-09-19"');
		expect(lines[2]).toContain('"2026-09-20"');
	});

	test("carries the totals and the derived hit rate", () => {
		const row = tokenUsageCsv(report([bucket()])).split("\n")[1];
		// 1000 + 500 + 3000 + 1000 billed, 3000 of 5000 prompt tokens cached.
		expect(row).toContain('"5500"');
		expect(row).toContain('"0.6000"');
		expect(row).toContain('"Z.ai"');
	});

	test("a workspace path with separators survives the round trip", () => {
		expect(tokenUsageCsv(report([bucket()]))).toContain('"D:\\work\\app"');
	});

	test("quotes escape rather than break the column layout", () => {
		const row = tokenUsageCsv(report([bucket({ model: 'weird","model' })])).split("\n")[1];
		expect(row).toContain('"weird"",""model"');
		// Eight quoted fields before the numbers, whatever the model is called.
		expect(row.split(",").length).toBe(15);
	});

	test("a report with nothing in it is still a valid file", () => {
		expect(tokenUsageCsv(report([]))).toBe(`${tokenUsageCsv(report([])).trim()}\n`);
		expect(tokenUsageCsv(report([])).trim().split("\n")).toHaveLength(1);
	});
});
