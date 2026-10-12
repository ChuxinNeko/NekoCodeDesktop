import { describe, expect, test } from "bun:test";
import { createWorkflowTools, type WorkflowToolHost } from "../../src/main/workflow-tools";

const tools = createWorkflowTools({} as WorkflowToolHost);

describe("workflow tool execution modes", () => {
	test("code_search fans out in parallel", () => {
		expect(tools.find((tool) => tool.name === "code_search")?.executionMode).toBe("parallel");
	});

	test("code_search requests locations and facts, not delegated solutions", () => {
		const description = tools.find((tool) => tool.name === "code_search")!.description;
		expect(description).toContain("not a problem-solving agent");
		expect(description).toContain("Do not forward the entire user request");
		expect(description).toContain("Root-cause analysis, solution design and final answers remain with the caller");
	});

	test("the session-steering tools stay sequential", () => {
		for (const tool of tools.filter((entry) => entry.name !== "code_search"))
			expect(tool.executionMode, tool.name).toBe("sequential");
	});
});
