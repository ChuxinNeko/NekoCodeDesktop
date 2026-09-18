import { describe, expect, test } from "bun:test";
import { AGENT_PHASES, WORK_MODES } from "../shared/workflow";
import {
	buildModePrompt,
	COMPACTION_INSTRUCTIONS,
	FILE_TOOL_NAMES,
	NATIVE_TOOL_NAMES,
	toolsForMode,
	WORKFLOW_TOOL_NAMES,
} from "./prompt-library";

describe("PI prompt library", () => {
	for (const mode of WORK_MODES) {
		test(mode + " resolves placeholders and uses registered PI tools", () => {
			const context = { mode, permission: "auto" as const, modelId: "test/model" };
			const prompt = buildModePrompt(context);
			expect(prompt).toContain("test/model");
			expect(prompt).not.toContain("{{");
			expect(prompt).not.toContain("DEBUG_SERVER_ENDPOINT");
			for (const tool of toolsForMode(context))
				expect([...NATIVE_TOOL_NAMES, ...WORKFLOW_TOOL_NAMES, ...FILE_TOOL_NAMES]).toContain(tool);
		});
		test(mode + " respects the independent read-only permission", () => {
			const names = toolsForMode({ mode, permission: "read-only" });
			for (const name of ["write", "edit", "bash", "powershell", "debug_log", "commit_message"])
				expect(names).not.toContain(name);
		});
	}
	test("Ask and Plan remain read-only even with full-access selected", () => {
		for (const mode of ["ask", "plan"] as const)
			for (const name of ["write", "edit", "bash", "powershell", "task"])
				expect(toolsForMode({ mode, permission: "full-access" })).not.toContain(name);
	});
	test("headless automations and child sessions cannot wait for UI or recursively delegate", () => {
		for (const context of [
			{ mode: "agent" as const, permission: "auto" as const, headless: true },
			{ mode: "agent" as const, permission: "auto" as const, child: true },
		]) {
			for (const tool of WORKFLOW_TOOL_NAMES) expect(toolsForMode(context)).not.toContain(tool);
		}
		expect(toolsForMode({ mode: "agent", permission: "auto", child: true })).not.toContain("bash");
		expect(toolsForMode({ mode: "commit", permission: "full-access" })).toEqual([]);
	});
	for (const phase of AGENT_PHASES) {
		test("agent phase " + phase + " carries its own discipline and registered tools", () => {
			const context = { mode: "agent" as const, permission: "auto" as const, phase };
			const prompt = buildModePrompt(context);
			expect(prompt).toContain("当前阶段：" + phase);
			expect(prompt).toContain("Agent 全自动工作模式");
			expect(prompt).not.toContain("{{");
			for (const tool of toolsForMode(context))
				expect([...NATIVE_TOOL_NAMES, ...WORKFLOW_TOOL_NAMES, ...FILE_TOOL_NAMES]).toContain(tool);
		});
	}
	test("the investigating phases stay read-only even with full access selected", () => {
		for (const phase of ["answer", "plan"] as const) {
			const names = toolsForMode({ mode: "agent", permission: "full-access", phase });
			for (const tool of ["write", "edit", "bash", "powershell", "task", "debug_log"])
				expect(names).not.toContain(tool);
		}
	});
	test("only the phase that owns a capability exposes its tool", () => {
		const of = (phase: (typeof AGENT_PHASES)[number]) =>
			toolsForMode({ mode: "agent", permission: "auto", phase });
		expect(of("delegate")).toContain("task");
		expect(of("execute")).not.toContain("task");
		expect(of("debug")).toContain("debug_log");
		expect(of("execute")).not.toContain("debug_log");
		expect(of("execute")).toContain("write");
	});
	test("sessions that cannot switch are not told about the phase router", () => {
		for (const context of [
			{ mode: "agent" as const, permission: "auto" as const, headless: true },
			{ mode: "agent" as const, permission: "auto" as const, child: true },
		]) {
			const prompt = buildModePrompt(context);
			expect(prompt).not.toContain("Agent 全自动工作模式");
			// The discipline of the phase it does run still applies.
			expect(prompt).toContain("当前阶段：execute");
		}
		expect(buildModePrompt({ mode: "agent", permission: "auto" })).toContain(
			"Agent 全自动工作模式",
		);
	});
	test("agent defaults to the execute phase when none is set", () => {
		expect(toolsForMode({ mode: "agent", permission: "auto" })).toEqual(
			toolsForMode({ mode: "agent", permission: "auto", phase: "execute" }),
		);
	});
	test("plugin tools ride with the write tools, never into a read-only mode", () => {
		const pluginTools = ["linear_issue", "deploy"];
		// Where the session may act, an enabled plugin's tools are callable.
		const acting = toolsForMode({ mode: "agent", permission: "auto", phase: "execute", pluginTools });
		expect(acting).toContain("linear_issue");
		expect(acting).toContain("deploy");

		// Where it may only look, they are not: a read-only mode that can call an
		// unknown tool is not read-only.
		for (const context of [
			{ mode: "agent" as const, permission: "auto" as const, phase: "plan" as const, pluginTools },
			{ mode: "agent" as const, permission: "auto" as const, phase: "answer" as const, pluginTools },
			{ mode: "ask" as const, permission: "full-access" as const, pluginTools },
			{ mode: "agent" as const, permission: "read-only" as const, pluginTools },
		])
			expect(toolsForMode(context)).not.toContain("linear_issue");
	});
	test("a plugin overriding a built-in does not double it in the list", () => {
		const names = toolsForMode({
			mode: "agent",
			permission: "auto",
			phase: "execute",
			pluginTools: ["read"],
		});
		expect(names.filter((name) => name === "read")).toHaveLength(1);
	});
	test("model names are interpolated literally", () => {
		expect(
			buildModePrompt({ mode: "agent", permission: "auto", modelId: "provider/$&model" }),
		).toContain("provider/$&model");
	});
	test("compaction preserves PI's checkpoint structure", () => {
		for (const heading of ["Goal", "Progress", "Next Steps", "Critical Context"])
			expect(COMPACTION_INSTRUCTIONS).toContain(heading);
	});

	test("automatic planning carries implementation authority while manual Plan stays gated", () => {
		const automatic = buildModePrompt({ mode: "agent", phase: "plan", permission: "auto" });
		expect(automatic).toContain("自动匹配最合适的工作阶段");
		expect(automatic).toContain("不重复索要认可");
		expect(automatic).toContain("用户明确只要方案、暂不修改或要求先确认");
		expect(automatic).not.toContain("向用户展示计划并取得认可后");
		const manual = buildModePrompt({ mode: "plan", permission: "auto" });
		expect(manual).toContain("必须由界面取得用户确认");
		expect(manual).toContain("计划完成不意味着获得实施授权");
		expect(manual).not.toContain("Agent 全自动工作模式");
	});

	for (const phase of AGENT_PHASES) {
		test("Fusion keeps " + phase + " discipline and describes its actual delegation tools", () => {
			const context = { mode: "agent" as const, phase, fusionRole: "lead" as const, permission: "auto" as const };
			const prompt = buildModePrompt(context);
			expect(prompt).toContain("### 当前阶段：" + phase);
			expect(prompt).toContain("Agent 全自动工作模式");
			expect(prompt).not.toContain("只有 Multitask 模式");
			expect(prompt).not.toContain("最多四个活动 worker");
			if (toolsForMode(context).includes("task")) {
				expect(prompt).toContain("本阶段可用 task：Fusion");
				expect(prompt).toContain("最多一个活动任务");
			} else {
				expect(prompt).toContain("本阶段没有 task");
				expect(prompt).not.toContain("本阶段可用 task");
			}
		});
	}

	test("unattended sessions receive no instructions to ask the user to switch modes", () => {
		for (const flags of [{ headless: true }, { child: true }]) {
			const prompt = buildModePrompt({ mode: "agent", permission: "auto", ...flags });
			expect(prompt).toContain("本会话没有 switch_mode");
			expect(prompt).toContain("本会话不能等待用户交互");
			expect(prompt).not.toContain("必须由界面取得用户确认");
			expect(prompt).not.toContain("通过 question 界面卡片");
		}
	});
});
