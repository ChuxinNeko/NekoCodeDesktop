import { describe, expect, test } from "bun:test";
import { MAX_PASSWORD_LENGTH, hashPassword, passwordProblem, verifyPassword } from "./passwords";

describe("passwordProblem", () => {
	test("accepts an ordinary passphrase", () => {
		expect(passwordProblem("correct horse battery")).toBeNull();
		expect(passwordProblem("hunter2hunter2")).toBeNull();
	});

	test("rejects one that is too short", () => {
		expect(passwordProblem("short")).toContain("至少");
	});

	test("rejects one long enough to be a denial of service", () => {
		// Argon2 will spend real CPU on whatever it is handed, and this endpoint
		// is reachable by anyone.
		expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBe("密码过长");
	});

	test("rejects an all-digit password", () => {
		expect(passwordProblem("12345678")).toContain("数字");
	});
});

describe("hashPassword / verifyPassword", () => {
	test("a hash verifies against its own password", async () => {
		const hash = await hashPassword("correct horse battery");
		expect(await verifyPassword("correct horse battery", hash)).toBe(true);
	});

	test("rejects the wrong password", async () => {
		const hash = await hashPassword("correct horse battery");
		expect(await verifyPassword("correct horse batteries", hash)).toBe(false);
	});

	test("is salted — the same password hashes differently each time", async () => {
		const [a, b] = await Promise.all([hashPassword("same password"), hashPassword("same password")]);
		expect(a).not.toBe(b);
		expect(await verifyPassword("same password", a)).toBe(true);
		expect(await verifyPassword("same password", b)).toBe(true);
	});

	test("uses argon2id", async () => {
		expect(await hashPassword("whatever it is")).toStartWith("$argon2id$");
	});

	test("a corrupt hash is a failed check, not a crash", async () => {
		// Otherwise a damaged row turns a wrong password into a 500.
		expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
		expect(await verifyPassword("anything", "")).toBe(false);
	});
});
