import { describe, expect, test } from "bun:test";
import { CODE_LENGTH, generateCode, hashCode, isWellFormed, matchesCode } from "./codes";

const SECRET = "test-secret-at-least-32-characters-long";

describe("generateCode", () => {
	test("is always six digits, leading zeros included", () => {
		for (let at = 0; at < 500; at++) {
			const code = generateCode();
			expect(code).toHaveLength(CODE_LENGTH);
			expect(code).toMatch(/^\d{6}$/);
		}
	});

	test("covers the whole range rather than a corner of it", () => {
		const seen = new Set(Array.from({ length: 400 }, () => generateCode()));
		// 400 draws from a million: collisions should be rare, and a generator
		// stuck on a narrow range would show up here immediately.
		expect(seen.size).toBeGreaterThan(390);
	});
});

describe("isWellFormed", () => {
	test("accepts exactly six digits", () => {
		expect(isWellFormed("000000")).toBe(true);
		expect(isWellFormed("123456")).toBe(true);
	});

	test("rejects anything else", () => {
		for (const bad of ["12345", "1234567", "12345a", "", " 123456", "12 34 56"]) {
			expect(isWellFormed(bad)).toBe(false);
		}
	});
});

describe("hashCode", () => {
	test("is stable for the same inputs", () => {
		expect(hashCode("123456", "a@b.com", SECRET)).toBe(hashCode("123456", "a@b.com", SECRET));
	});

	test("binds the code to the address it was sent to", () => {
		// A code captured for one address must not be redeemable against another.
		expect(hashCode("123456", "a@b.com", SECRET)).not.toBe(hashCode("123456", "c@d.com", SECRET));
	});

	test("depends on the server secret", () => {
		// Without this a stolen database is a table of live codes: six digits is
		// a rainbow table a laptop builds in a second.
		expect(hashCode("123456", "a@b.com", SECRET)).not.toBe(hashCode("123456", "a@b.com", "other"));
	});

	test("never contains the code itself", () => {
		expect(hashCode("123456", "a@b.com", SECRET)).not.toContain("123456");
	});
});

describe("matchesCode", () => {
	const stored = hashCode("123456", "a@b.com", SECRET);

	test("accepts the right code", () => {
		expect(matchesCode("123456", "a@b.com", SECRET, stored)).toBe(true);
	});

	test("rejects a wrong code, a wrong address and a wrong secret", () => {
		expect(matchesCode("654321", "a@b.com", SECRET, stored)).toBe(false);
		expect(matchesCode("123456", "c@d.com", SECRET, stored)).toBe(false);
		expect(matchesCode("123456", "a@b.com", "other", stored)).toBe(false);
	});

	test("rejects a malformed code without throwing", () => {
		expect(matchesCode("abc", "a@b.com", SECRET, stored)).toBe(false);
		expect(matchesCode("", "a@b.com", SECRET, stored)).toBe(false);
	});

	test("rejects a corrupt stored hash instead of crashing", () => {
		// `timingSafeEqual` throws on a length mismatch, which would turn a bad
		// row into a 500 and tell an attacker which accounts are broken.
		expect(matchesCode("123456", "a@b.com", SECRET, "deadbeef")).toBe(false);
		expect(matchesCode("123456", "a@b.com", SECRET, "")).toBe(false);
	});
});
