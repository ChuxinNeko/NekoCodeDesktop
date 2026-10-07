import { afterEach, describe, expect, test } from "bun:test";
import common from "../../pi/packages/prompt/common_prefix.md?raw";
import agent from "../../pi/packages/prompt/agent/prompt.md?raw";
import ask from "../../pi/packages/prompt/ask/prompt.md?raw";
import plan from "../../pi/packages/prompt/plan/prompt.md?raw";
import debug from "../../pi/packages/prompt/debug/prompt.md?raw";
import phaseExecute from "../../pi/packages/prompt/agent/phases/execute.md?raw";
import planReminder from "../../pi/packages/prompt/plan/system_reminder.txt?raw";
import debugInitial from "../../pi/packages/prompt/debug/system_reminder_initial.txt?raw";
import { AGENT_PHASES, WORK_MODES } from "../../src/shared/workflow";
import { buildModePrompt, configureCustomPrompt, FAST_CONTEXT_PROMPT, toolsForMode, type PromptContext } from "../../src/main/prompt-library";

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

describe("semantic_search availability", () => {
	test("offered wherever grep is once the index is on, and only then", () => {
		for (const mode of WORK_MODES) {
			expect(toolsForMode({ ...base, mode, semanticSearch: true }), mode).toContain("semantic_search");
			expect(toolsForMode({ ...base, mode }), mode).not.toContain("semantic_search");
		}
	});

	test("read-only sessions, workers and Fast Context keep it", () => {
		expect(toolsForMode({ mode: "agent", permission: "read-only", interactive: true, semanticSearch: true })).toContain("semantic_search");
		expect(toolsForMode({ ...base, mode: "subagent", child: true, interactive: false, semanticSearch: true })).toContain("semantic_search");
		expect(toolsForMode({ ...base, mode: "subagent", child: true, fastContext: true, interactive: false, semanticSearch: true })).toContain("semantic_search");
	});

	test("the prompt says when to prefer it over grep", () => {
		expect(buildModePrompt({ ...base, mode: "agent", semanticSearch: true })).toContain("semantic_search 按含义检索");
		expect(buildModePrompt({ ...base, mode: "agent" })).not.toContain("semantic_search 按含义检索");
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

	test("a Fusion Lead hands code finding to the Sidekick in every phase", () => {
		for (const phase of AGENT_PHASES) {
			const prompt = buildModePrompt({ ...base, mode: "agent", phase, fusionRole: "lead" });
			expect(prompt, phase).toContain("### 查找代码交给 Sidekick");
			expect(prompt, phase).toContain("code_search 由 Sidekick 执行");
			expect(prompt, phase).not.toContain("已知文件、确切符号或小任务直接 read/grep");
		}
		expect(buildModePrompt({ ...base, mode: "agent" })).not.toContain("查找代码交给 Sidekick");
	});
});

describe("Fusion responsibility split", () => {
	test("Lead cannot execute edits, commands or arbitrary plugin tools in any phase", () => {
		for (const phase of AGENT_PHASES) {
			const tools = toolsForMode({ ...base, mode: "agent", phase, fusionRole: "lead",
				shellTools: ["powershell"], sshTools: true, pluginTools: ["browser_action", "custom_write", "edit"] });
			for (const name of ["edit", "write", "ast_edit", "bash", "powershell", "ssh", "remote_desktop", "browser_action", "custom_write"])
				expect(tools, `${phase}: ${name}`).not.toContain(name);
			expect(tools).toContain("read");
			expect(tools).toContain("code_search");
			if (!["answer", "plan"].includes(phase)) expect(tools).toContain("task");
		}
		for (const mode of WORK_MODES) {
			const tools = toolsForMode({ ...base, mode, fusionRole: "lead" });
			expect(tools, mode).not.toContain("edit");
			expect(tools, mode).not.toContain("bash");
		}
	});
	test("only Sidekick gets investigation tools; Lead keeps evidence review and delegation", () => {
		const investigation = ["grep", "find", "ls", "stat", "ast_grep", "semantic_search", "github", "web_search", "web_fetch"];
		for (const phase of AGENT_PHASES) {
			const lead = toolsForMode({ ...base, mode: "agent", phase, fusionRole: "lead", webTools: true, semanticSearch: true });
			for (const name of investigation) expect(lead, `${phase}: ${name}`).not.toContain(name);
			expect(lead).toContain("read");
			expect(lead).toContain("code_search");
		}
		const side = toolsForMode({ ...base, mode: "subagent", child: true, fusionRole: "sidekick",
			permission: "read-only", webTools: true, semanticSearch: true });
		for (const name of investigation) expect(side, name).toContain(name);
		expect(side).not.toContain("write");
	});
	test("ordinary sessions keep execution tools and Sidekick retains permission boundaries", () => {
		expect(toolsForMode({ ...base, mode: "agent" })).toContain("edit");
		const tools = toolsForMode({ ...base, mode: "agent", child: true, fusionRole: "sidekick",
			allowWorkerShell: true, permission: "read-only" });
		expect(tools).not.toContain("edit");
		expect(tools).not.toContain("bash");
	});
	test("Sidekick owns investigation while Lead decides from evidence and delegates execution", () => {
		const prompt = buildModePrompt({ ...base, mode: "agent", fusionRole: "lead" });
		expect(prompt).toContain("调查由 Sidekick 执行，决策由 Lead 完成");
		expect(prompt).not.toContain("根因调查、假设取舍、架构设计、安全边界和正确性判断由你负责");
		expect(prompt).toContain("编写代码、文件编辑、构建、测试和改动验证必须交给 Sidekick 实际执行");
		expect(prompt).toContain("微小改动也不例外");
		expect(prompt).not.toContain("微小改动，以及必须由你处理的高正确性工作可直接完成");
		expect(prompt).toContain("必须填写 task.executionPlan");
		expect(prompt).toContain("不再亲自重复构建/测试");
		expect(prompt).toContain("不能保证固定降本比例");
	});
	test("Sidekick executes decisions and reports acceptance coverage and failures", () => {
		const prompt = buildModePrompt({ ...base, mode: "agent", child: true, fusionRole: "sidekick" });
		expect(prompt).toContain("按 Lead 给出的 executionPlan");
		expect(prompt).toContain("每项 acceptanceCriteria 的满足情况");
		expect(prompt).toContain("verification.mode=skip 时禁止测试、构建和浏览器验证");
		expect(prompt).toContain("返回错误证据和已完成部分");
	});
	test("planning remains read-only and the Sidekick cannot recursively delegate", () => {
		expect(toolsForMode({ ...base, mode: "agent", phase: "plan", fusionRole: "lead" })).not.toContain("task");
		const tools = toolsForMode({ ...base, mode: "agent", child: true, fusionRole: "sidekick", allowWorkerShell: true });
		expect(tools).not.toContain("task");
		expect(tools).toContain("edit");
		expect(tools.some((name) => ["bash", "powershell"].includes(name))).toBe(true);
	});
});

describe("custom prompts", () => {
	afterEach(() => configureCustomPrompt(() => null));
	const defaultLine = (text: string) => text.trim().split("\n").find((line) => line.trim().length > 12)!.trim();

	test("a custom prompt replaces the default role, rules and mode guidance", () => {
		configureCustomPrompt(() => "MY PROMPT for {{MODEL_ID}} $&");
		for (const [mode, phase] of [["agent", "execute"], ["ask", undefined], ["plan", undefined], ["debug", undefined]] as const) {
			const prompt = buildModePrompt({ ...base, mode, phase, modelId: "x/y" });
			expect(prompt.startsWith("MY PROMPT for x/y $&\n\n## 运行时策略（由运行时生成）\n当前工作模式：" + mode), mode).toBe(true);
			for (const text of [common, agent, ask, plan, debug, phaseExecute, planReminder, debugInitial])
				expect(prompt.includes(defaultLine(text)), mode).toBe(false);
		}
	});

	test("the runtime policy, tools and session state still come with it", () => {
		configureCustomPrompt(() => "MINE");
		const prompt = buildModePrompt({ ...base, mode: "ask", permission: "read-only", workflowContext: "{}", memory: "## memory" });
		expect(prompt).toContain("硬性只读");
		expect(prompt).toContain("本会话可用工具");
		expect(prompt).toContain("code_search");
		expect(prompt).toContain("## 当前会话工作流状态");
		expect(prompt).toContain("## memory");
	});

	test("helpers keep their default prompts", () => {
		configureCustomPrompt(() => "MINE");
		expect(buildModePrompt({ mode: "subagent", permission: "read-only", child: true, fastContext: true })).toContain(FAST_CONTEXT_PROMPT);
		expect(buildModePrompt({ mode: "agent", permission: "auto", child: true, fusionRole: "sidekick" })).not.toContain("MINE");
		const lead = buildModePrompt({ ...base, mode: "agent", fusionRole: "lead", pluginTools: ["custom_write"] });
		expect(lead).toContain("## Fusion · Lead");
		expect(lead).toContain("必须交给 Sidekick 实际执行");
		expect(toolsForMode({ ...base, mode: "agent", fusionRole: "lead", pluginTools: ["custom_write"] })).not.toContain("custom_write");
		expect(buildModePrompt({ ...base, mode: "commit" })).not.toContain("MINE");
	});

	test("no custom prompt is the default prompt", () => {
		expect(buildModePrompt({ ...base, mode: "ask" })).toContain(defaultLine(ask));
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

describe("web tool availability", () => {
	test("every mode and agent phase offers them when switched on, read-only ones included", () => {
		for (const mode of WORK_MODES) {
			const tools = toolsForMode({ ...base, mode, permission: "read-only", webTools: true });
			expect(tools, mode).toContain("web_search");
			expect(tools, mode).toContain("web_fetch");
		}
		for (const phase of AGENT_PHASES) {
			expect(toolsForMode({ ...base, mode: "agent", phase, webTools: true }), phase).toContain("web_fetch");
		}
	});

	test("they are gone when switched off, or when nobody said", () => {
		expect(toolsForMode({ ...base, mode: "agent", webTools: false })).not.toContain("web_search");
		expect(toolsForMode({ ...base, mode: "agent" })).not.toContain("web_fetch");
	});

	test("the prompt warns that web content is data, only when they are present", () => {
		expect(buildModePrompt({ ...base, mode: "agent", webTools: true })).toContain("web_search / web_fetch 访问公网");
		expect(buildModePrompt({ ...base, mode: "agent" })).not.toContain("web_search / web_fetch 访问公网");
	});
});

describe("structural and GitHub tool guidance", () => {
	const guidance = {
		ast_grep: "ast_grep 按语法结构找代码",
		ast_edit: "ast_edit 是跨文件的结构化改写",
		github: "github 工具直接读取 GitHub",
	};

	test("a phase that can write gets all three", () => {
		const prompt = buildModePrompt({ ...base, mode: "agent", phase: "execute" });
		for (const line of Object.values(guidance)) expect(prompt).toContain(line);
	});

	test("a read-only mode gets search and GitHub guidance but no rewrite guidance", () => {
		const prompt = buildModePrompt({ ...base, mode: "ask" });
		expect(prompt).toContain(guidance.ast_grep);
		expect(prompt).toContain(guidance.github);
		expect(prompt).not.toContain(guidance.ast_edit);
	});

	test("a tool the session cannot call is never described", () => {
		// Fast Context explorers are limited to local read tools.
		const prompt = buildModePrompt({ ...base, mode: "subagent", child: true, fastContext: true, permission: "read-only" });
		const tools = toolsForMode({ ...base, mode: "subagent", child: true, fastContext: true, permission: "read-only" });
		for (const [name, line] of Object.entries(guidance)) expect(prompt.includes(line)).toBe(tools.includes(name));
		expect(tools).not.toContain("github");
		expect(prompt).toContain(guidance.ast_grep);
	});
});
