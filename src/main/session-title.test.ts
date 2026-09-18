import { describe, expect, test } from "bun:test";
import { buildTitleRequest, sanitizeGeneratedTitle, TITLE_MAX_LENGTH } from "./session-title";

describe("buildTitleRequest", () => {
	test("sends the opening prompt as the only message", () => {
		const request = buildTitleRequest("why is the build red", { now: 1000 });
		expect(request.messages).toEqual([
			{ role: "user", content: "why is the build red", timestamp: 1000 },
		]);
		expect(request.systemPrompt).toContain("same language");
	});

	test("leaves room for a reasoning model to think, inside the model's own cap", () => {
		// Plenty: the answer is one line, but on a reasoning model this budget is
		// spent on thinking first, and a truncated answer is no answer at all.
		expect(buildTitleRequest("why is the build red").maxTokens).toBe(4096);
		expect(buildTitleRequest("x", { modelMaxTokens: 1024 }).maxTokens).toBe(1024);
		expect(buildTitleRequest("x", { modelMaxTokens: 128_000 }).maxTokens).toBe(4096);
		expect(buildTitleRequest("x", { modelMaxTokens: 0 }).maxTokens).toBe(4096);
	});

	test("clips a pasted wall of context", () => {
		const request = buildTitleRequest("x".repeat(10_000));
		expect(request.messages[0]?.content.length).toBe(4000);
	});
});

describe("sanitizeGeneratedTitle", () => {
	test("keeps a well-formed answer as is", () => {
		expect(sanitizeGeneratedTitle("Fix the failing CI build")).toBe("Fix the failing CI build");
		expect(sanitizeGeneratedTitle("修复构建失败")).toBe("修复构建失败");
	});

	test("strips the wrappers models add", () => {
		expect(sanitizeGeneratedTitle('"Fix the CI build"')).toBe("Fix the CI build");
		expect(sanitizeGeneratedTitle("Title: Fix the CI build.")).toBe("Fix the CI build");
		expect(sanitizeGeneratedTitle("**Fix the CI build**")).toBe("Fix the CI build");
		expect(sanitizeGeneratedTitle("标题：修复构建失败。")).toBe("修复构建失败");
	});

	test("takes the first line of a chatty answer", () => {
		expect(sanitizeGeneratedTitle("\n\nFix the CI build\n\nLet me know if…")).toBe(
			"Fix the CI build",
		);
	});

	test("clips a long title to what a row can show", () => {
		const clipped = sanitizeGeneratedTitle("Fix ".repeat(30));
		expect(clipped.length).toBe(TITLE_MAX_LENGTH);
	});

	test("rejects an answer that is prose rather than a name", () => {
		expect(sanitizeGeneratedTitle("I would be happy to help. ".repeat(20))).toBe("");
		expect(sanitizeGeneratedTitle("   \n  ")).toBe("");
	});
});
