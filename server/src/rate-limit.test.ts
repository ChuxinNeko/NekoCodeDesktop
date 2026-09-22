import { describe, expect, test } from "bun:test";
import { RateLimiter, clientIp } from "./rate-limit";

describe("RateLimiter", () => {
	test("allows up to the limit and then refuses", () => {
		const limiter = new RateLimiter(3, 1000);
		expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, true]);
		expect(limiter.take("a")).toBe(false);
	});

	test("counts each key on its own", () => {
		const limiter = new RateLimiter(1, 1000);
		expect(limiter.take("a")).toBe(true);
		expect(limiter.take("b")).toBe(true);
		expect(limiter.take("a")).toBe(false);
	});

	test("lets the window slide", async () => {
		const limiter = new RateLimiter(1, 60);
		expect(limiter.take("a")).toBe(true);
		expect(limiter.take("a")).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(limiter.take("a")).toBe(true);
	});

	test("reports when the caller gets another go", () => {
		const limiter = new RateLimiter(1, 10_000);
		limiter.take("a");
		limiter.take("a");
		expect(limiter.retryAfter("a")).toBeGreaterThan(0);
		expect(limiter.retryAfter("never-seen")).toBe(0);
	});
});

describe("clientIp", () => {
	test("takes the leftmost entry of x-forwarded-for", () => {
		expect(clientIp({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })).toBe("203.0.113.5");
	});

	test("falls back to x-real-ip, then to unknown", () => {
		expect(clientIp({ "x-real-ip": "203.0.113.9" })).toBe("203.0.113.9");
		expect(clientIp({})).toBe("unknown");
	});
});
