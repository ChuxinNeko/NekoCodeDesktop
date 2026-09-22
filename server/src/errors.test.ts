import { describe, expect, test } from "bun:test";
import { isEmailShaped, normalizeEmail } from "./errors";

describe("normalizeEmail", () => {
	test("lower-cases and trims, so one address is one account", () => {
		expect(normalizeEmail("  Neko@Example.COM ")).toBe("neko@example.com");
	});
});

describe("isEmailShaped", () => {
	test("accepts ordinary addresses", () => {
		for (const email of [
			"neko@example.com",
			"a.b+tag@sub.example.co.uk",
			"noreply@nekofun.top",
			"用户@例子.中国",
		]) {
			expect(isEmailShaped(email)).toBe(true);
		}
	});

	test("rejects what is obviously not an address", () => {
		for (const email of ["", "neko", "neko@", "@example.com", "neko@example", "a b@example.com"]) {
			expect(isEmailShaped(email)).toBe(false);
		}
	});

	test("rejects one past the length a mailbox can be", () => {
		expect(isEmailShaped(`${"a".repeat(250)}@example.com`)).toBe(false);
	});
});
