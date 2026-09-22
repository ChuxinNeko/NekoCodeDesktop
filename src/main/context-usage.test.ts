import { describe, expect, test } from "bun:test";
import { contextUsage } from "./context-usage";

const usage = (over: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }> = {}) => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	...over,
});

const assistant = (over: Parameters<typeof usage>[0] = {}, stopReason?: string) => ({
	role: "assistant",
	usage: usage(over),
	...(stopReason === undefined ? {} : { stopReason }),
});

describe("contextUsage", () => {
	test("reads the newest reported call, not the sum of the turn", () => {
		// Ten tool calls re-send the whole conversation ten times; adding them up
		// would put a 30k conversation at 300k.
		const messages = [
			{ role: "user" },
			assistant({ totalTokens: 10_000 }),
			{ role: "user" },
			assistant({ totalTokens: 12_000 }),
			assistant({ totalTokens: 14_000 }),
		];
		expect(contextUsage(messages, 200_000)).toEqual({ used: 14_000, window: 200_000 });
	});

	test("falls back to the parts when no total is reported", () => {
		const messages = [assistant({ input: 100, output: 20, cacheRead: 800, cacheWrite: 80 })];
		expect(contextUsage(messages, 8_000)?.used).toBe(1_000);
	});

	test("skips a call that was aborted or failed part-way", () => {
		const messages = [
			assistant({ totalTokens: 9_000 }),
			assistant({ totalTokens: 120 }, "aborted"),
			assistant({ totalTokens: 40 }, "error"),
		];
		expect(contextUsage(messages, 100_000)?.used).toBe(9_000);
	});

	test("skips a call that reported nothing at all", () => {
		const messages = [assistant({ totalTokens: 7_000 }), assistant()];
		expect(contextUsage(messages, 100_000)?.used).toBe(7_000);
	});

	test("lands after a compaction rather than on the larger figures before it", () => {
		// Kept pre-compaction messages still carry their old usage; walking
		// backwards is what makes the newest one win.
		const messages = [assistant({ totalTokens: 180_000 }), { role: "user" }, assistant({ totalTokens: 12_000 })];
		expect(contextUsage(messages, 200_000)?.used).toBe(12_000);
	});

	test("is null before any reply, and for a model that declares no window", () => {
		expect(contextUsage([{ role: "user" }], 200_000)).toBeNull();
		expect(contextUsage([assistant({ totalTokens: 9_000 })], undefined)).toBeNull();
		expect(contextUsage([assistant({ totalTokens: 9_000 })], 0)).toBeNull();
	});
});
