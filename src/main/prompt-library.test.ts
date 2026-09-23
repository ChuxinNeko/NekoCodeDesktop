import { describe, expect, test } from "bun:test";
import { AGENT_PHASES, WORK_MODES } from "../shared/workflow";
import { buildModePrompt, FAST_CONTEXT_PROMPT, toolsForMode, type PromptContext } from "./prompt-library";

const base = { permission: "auto", interactive: true } as const;

describe("code_search availability", () => {
	test("every interactive mode and agent phase offers it", () => {
		for (const mode of WORK_MODES) {
			const context: PromptContext = { ...base, mode };
			expect(toolsForMode(context), mode).toContain("code_search");
		}
		for (const phase of AGENT_PHASES) {
			const context: PromptContext = { ...base, mode: "agent", phase };
			expect(toolsForMode(context), phase).toContain("code_search");
		}
	});

	test("child and helper sessions cannot reach it", () => {
		const child: PromptContext = { ...base, mode: "agent", child: true };
		expect(toolsForMode(child)).not.toContain("code_search");
		const subagent: PromptContext = { ...base, mode: "subagent" };
		expect(toolsForMode(subagent)).not.toContain("code_search");
	});

	test("it survives read-only permission", () => {
		const context: PromptContext = { mode: "agent", permission: "read-only", interactive: true };
		expect(toolsForMode(context)).toContain("code_search");
	});
});

describe("fast context prompts", () => {
	test("the explorer helper gets the explorer discipline", () => {
		const prompt = buildModePrompt({
			mode: "subagent", permission: "read-only", child: true, fastContext: true,
		});
		expect(prompt).toContain(FAST_CONTEXT_PROMPT);
	});

	test("parents are told when to prefer code_search", () => {
		const prompt = buildModePrompt({ mode: "agent", permission: "auto", interactive: true });
		expect(prompt).toContain("code_search");
	});
});

describe("browser_screenshot policy", () => {
	test("a writable parent with the tool is told the image comes back attached", () => {
		const prompt = buildModePrompt({
			mode: "agent",
			permission: "auto",
			interactive: true,
			pluginTools: ["browser_screenshot"],
		});
		expect(prompt).toContain("browser_screenshot 既保存 PNG");
	});

	test("the policy is absent without the tool", () => {
		const prompt = buildModePrompt({ mode: "agent", permission: "auto", interactive: true });
		expect(prompt).not.toContain("browser_screenshot 既保存 PNG");
	});
});
