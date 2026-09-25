import { describe, expect, test } from "bun:test";
import { displayInitPrompt, INIT_PROMPT_MARKER } from "../shared/instructions";
import { MENTION_BLOCK_CLOSE, MENTION_BLOCK_OPEN } from "../shared/mentions";
import { projectMessages } from "./agent-projection";
import { MEMORY_TOOL_NAME } from "./memory-tool";
import { buildModePrompt, toolsForMode, type PromptContext } from "./prompt-library";
import { initPrompt } from "./project-instructions";

describe("memory in the prompt", () => {
	const base: PromptContext = { mode: "agent", permission: "auto", interactive: true };

	test("the tool is offered only to sessions wired for it, even read-only ones", () => {
		expect(toolsForMode(base)).not.toContain(MEMORY_TOOL_NAME);
		expect(toolsForMode({ ...base, memoryTool: true })).toContain(MEMORY_TOOL_NAME);
		expect(toolsForMode({ ...base, memoryTool: true, permission: "read-only" })).toContain(MEMORY_TOOL_NAME);
		expect(toolsForMode({ ...base, mode: "ask", memoryTool: true })).toContain(MEMORY_TOOL_NAME);
	});

	test("workers and automations never write memory", () => {
		expect(toolsForMode({ ...base, memoryTool: true, child: true })).not.toContain(MEMORY_TOOL_NAME);
		expect(toolsForMode({ ...base, memoryTool: true, headless: true })).not.toContain(MEMORY_TOOL_NAME);
	});

	test("the section lands in the system prompt", () => {
		const prompt = buildModePrompt({ ...base, memory: "## 长期记忆\n- [abcd1234] use bun" });
		expect(prompt).toContain("use bun");
	});
});

describe("transcript display", () => {
	test("a user message shows as typed, without the @ attachments", () => {
		const sent = `explain @a.ts\n\n${MENTION_BLOCK_OPEN}\n<file path="a.ts">x</file>\n${MENTION_BLOCK_CLOSE}`;
		const cells = projectMessages([{ role: "user", content: [{ type: "text", text: sent }], timestamp: 1 }]);
		expect(cells[0]).toMatchObject({ type: "user", text: "explain @a.ts" });
	});

	test("/init shows as the command, with the user's own words", () => {
		const prompt = initPrompt(process.cwd(), "只写中文");
		expect(prompt.startsWith(INIT_PROMPT_MARKER)).toBe(true);
		expect(displayInitPrompt(prompt)).toBe("/init 只写中文");
		expect(displayInitPrompt(initPrompt(process.cwd(), ""))).toBe("/init");
		const cells = projectMessages([{ role: "user", content: prompt, timestamp: 1 }]);
		expect(cells[0]).toMatchObject({ type: "user", text: "/init 只写中文" });
	});
});
