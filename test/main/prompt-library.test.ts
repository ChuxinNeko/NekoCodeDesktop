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

test("OpenUI is advertised only to interactive sessions with the actual component specification", () => {
	const prompt = buildModePrompt({ ...base, mode: "agent" });
	expect(prompt).toContain("## 交互式回复");
	expect(prompt).toContain("Form(name: string, buttons: Buttons");
	expect(prompt).toContain("Never invent metrics");
	for (const flags of [{ child: true }, { headless: true }, { fastContext: true }, { interactive: false }]) {
		expect(buildModePrompt({ ...base, mode: "agent", ...flags })).not.toContain("## 交互式回复");
	}
});

test("interactive explanations can end in Mermaid without expanding investigation scope", () => {
	const prompt = buildModePrompt({ ...base, mode: "agent" });
	expect(prompt).toContain("## 正文流程图");
	expect(prompt).toContain("语言标记必须为 mermaid");
	expect(prompt).toContain("不为画图额外调用工具");
	expect(buildModePrompt({ ...base, mode: "subagent", child: true })).not.toContain("## 正文流程图");
});

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

	test("the explorer locates facts without solving a forwarded user problem", () => {
		const prompt = buildModePrompt({ mode: "subagent", permission: "read-only", child: true, fastContext: true });
		expect(prompt).toContain("只做项目结构摸底、代码定位和事实摘录");
		expect(prompt).toContain("即使请求包含完整用户问题");
		expect(prompt).toContain("不输出根因结论、修复方案或实施计划");
		expect(prompt).toContain("找到足够的入口和关键位置后立即返回");
	});

	test("parents are told when to prefer code_search", () => {
		const prompt = buildModePrompt({ mode: "agent", permission: "auto", interactive: true });
		expect(prompt).toContain("code_search");
	});

	test("a Fusion parent uses Fast Context for location rather than delegating its decisions", () => {
		for (const phase of AGENT_PHASES) {
			const prompt = buildModePrompt({ ...base, mode: "agent", phase, fusionAgent: "main" });
			expect(prompt, phase).toContain("不能原样转发用户问题");
			expect(prompt, phase).toContain("代码查找固定由 Sidekick 完成");
			expect(prompt, phase).toContain("fusion_investigate");
			if (phase !== "delegate") expect(prompt).not.toContain("### Fast Context");
		}
	});
});

describe("Fusion identity and permission boundaries", () => {
	test("investigation is same-session and read-only in every phase", () => {
		for (const phase of AGENT_PHASES) {
			const context: PromptContext = { ...base, mode: "agent", phase, fusionAgent: "main" };
			expect(toolsForMode(context)).toContain("fusion_investigate");
			const tools = toolsForMode({ ...context, fusionModelRole: "sidekick", fusionInvestigation: true,
				pluginTools: ["plugin"], mcpTools: ["mcp__demo"] });
			for (const name of ["write", "edit", "ast_edit", "bash", "powershell", "plugin", "mcp__demo", "task", "code_search", "question", "switch_mode"])
				expect(tools).not.toContain(name);
			for (const name of ["read", "grep", "fusion_review"]) expect(tools).toContain(name);
			expect(buildModePrompt({ ...context, fusionModelRole: "sidekick", fusionInvestigation: true })).toContain("不是子代理，没有后台任务");
		}
	});
	test("inline handoff cannot enter read-only phases and review survives revoked write permission", () => {
		for (const mode of ["ask", "plan"] as const) {
			expect(toolsForMode({ ...base, mode, fusionAgent: "main", fusionModelRole: "lead" })).not.toContain("fusion_implement");
		}
		for (const fusionModelRole of ["lead", "sidekick"] as const) {
			const tools = toolsForMode({ ...base, mode: "agent", phase: "execute", permission: "read-only", fusionAgent: "main", fusionModelRole });
			for (const name of ["write", "edit", "ast_edit", "bash", "powershell", "fusion_implement"]) expect(tools).not.toContain(name);
			if (fusionModelRole === "sidekick") expect(tools).toContain("fusion_review");
		}
	});
	test("Lead cannot edit; Sidekick keeps phase and permission gates", () => {
		for (const phase of AGENT_PHASES) for (const fusionModelRole of ["lead", "sidekick"] as const) {
			const context: PromptContext = { ...base, mode: "agent", phase, fusionAgent: "main", fusionModelRole,
				shellTools: ["powershell"], pluginTools: ["mcp__demo__echo"] };
			const tools = toolsForMode(context);
			const ordinary = toolsForMode({ ...context, fusionAgent: undefined, fusionModelRole: undefined });
			for (const name of ["write", "edit", "ast_edit", "powershell", "mcp__demo__echo"])
				expect(tools.includes(name), `${phase}/${fusionModelRole}: ${name}`).toBe(fusionModelRole === "sidekick" && ordinary.includes(name));
			expect(tools).toContain("read");
		}
	});
	test("Lead delegates code location while Sidekick explorers retain investigation tools", () => {
		const investigation = ["grep", "find", "ls", "stat", "ast_grep", "semantic_search", "github", "web_search", "web_fetch"];
		for (const phase of AGENT_PHASES) {
			const tools = toolsForMode({ ...base, mode: "agent", phase, fusionAgent: "main", webTools: true, semanticSearch: true });
			for (const name of investigation.slice(0, 6)) expect(tools, `${phase}: ${name}`).not.toContain(name);
			for (const name of ["fusion_investigate", "read", ...investigation.slice(6)]) expect(tools, `${phase}: ${name}`).toContain(name);
			expect(tools.includes("code_search")).toBe(phase === "delegate");
			const sidekickTools = toolsForMode({ ...base, mode: "agent", phase, fusionAgent: "main", fusionModelRole: "sidekick", semanticSearch: true });
			for (const name of investigation.slice(0, 6)) expect(sidekickTools, `${phase}: ${name}`).toContain(name);
		}
		const tools = toolsForMode({ mode: "subagent", child: true, fusionAgent: "auxiliary",
			permission: "read-only", webTools: true, semanticSearch: true });
		for (const name of investigation) expect(tools).toContain(name);
		expect(tools).not.toContain("write");
	});
	test("read-only workers never receive arbitrary MCP tools even with a model or shell override", () => {
		const tools = toolsForMode({ mode: "agent", permission: "read-only", child: true,
			fusionAgent: "auxiliary", fusionModelRole: "lead", allowWorkerShell: true, mcpTools: ["mcp__demo__echo"] });
		for (const name of ["edit", "bash", "powershell", "mcp__demo__echo"]) expect(tools).not.toContain(name);
	});
	test("Fusion parent gives specific instructions for every edit", () => {
		const prompt = buildModePrompt({ ...base, mode: "agent", fusionAgent: "main" });
		expect(prompt).toContain("所有文件编辑都交给 Sidekick");
		expect(prompt).toContain("不要重复整个用户需求");
		expect(prompt).toContain("常规连贯修改优先在同一主会话交接");
		expect(prompt).toContain("即使只改一行，也必须通过 fusion_implement");
		expect(prompt).toContain("高风险改动先由 Lead 决定算法");
		expect(prompt).toContain("不重复读完整源码");
		expect(prompt).toContain("不轮询task_status");
		expect(prompt).toContain("不能保证固定降本比例");
	});
	test("workers follow parent specifications and cannot recursively delegate", () => {
		const context: PromptContext = { ...base, mode: "agent", child: true, fusionAgent: "auxiliary", allowWorkerShell: true };
		const prompt = buildModePrompt(context);
		expect(prompt).toContain("executionPlan");
		expect(prompt).toContain("每项 acceptanceCriteria 的满足情况");
		expect(prompt).toContain("verification.mode=skip 时禁止测试、构建和浏览器验证");
		const tools = toolsForMode(context);
		expect(tools).not.toContain("task");
		expect(tools).toContain("edit");
		expect(tools).toContain("bash");
	});
	test("MCP is discoverable and executable only in phases and permissions that allow arbitrary tools", () => {
		const mcpTools = [{ name: "mcp__demo__echo", description: "Echo parameters" }];
		for (const phase of AGENT_PHASES) {
			const context: PromptContext = { ...base, mode: "agent", phase, fusionAgent: "main",
				pluginTools: mcpTools.map((tool) => tool.name), delegatedMcpTools: mcpTools };
			const prompt = buildModePrompt(context);
			expect(prompt).toContain("mcp__demo__echo（Echo parameters）");
			expect(prompt).toContain("主会话中的 Sidekick 可在当前阶段与权限允许时调用");
			expect(toolsForMode(context)).not.toContain("mcp__demo__echo");
			expect(toolsForMode({ ...context, fusionModelRole: "sidekick" }).includes("mcp__demo__echo")).toBe(!["answer", "plan"].includes(phase));
			expect(toolsForMode({ ...context, permission: "read-only" })).not.toContain("mcp__demo__echo");
		}
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
		expect(buildModePrompt({ mode: "agent", permission: "auto", child: true, fusionAgent: "auxiliary" })).not.toContain("MINE");
		const lead = buildModePrompt({ ...base, mode: "agent", fusionAgent: "main", pluginTools: ["custom_write"] });
		expect(lead).toContain("## Fusion · Lead");
		expect(lead).toContain("不要重复整个用户需求");
		expect(toolsForMode({ ...base, mode: "agent", fusionAgent: "main", pluginTools: ["custom_write"] })).not.toContain("custom_write");
		expect(buildModePrompt({ ...base, mode: "commit" })).not.toContain("MINE");
	});

	test("no custom prompt is the default prompt", () => {
		expect(buildModePrompt({ ...base, mode: "ask" })).toContain(defaultLine(ask));
	});
});

describe("webpage element verification policy", () => {
	afterEach(() => configureCustomPrompt(() => null));
	test("default element checks and stopping rules reach parents, custom prompts and workers", () => {
		configureCustomPrompt(() => "CUSTOM");
		for (const context of [
			{ mode: "agent" as const, permission: "auto" as const },
			{ mode: "agent" as const, permission: "auto" as const, fusionAgent: "main" as const },
			{ mode: "subagent" as const, permission: "auto" as const, child: true },
			{ mode: "agent" as const, permission: "auto" as const, child: true, fusionAgent: "auxiliary" as const, allowWorkerShell: true },
		]) {
			const prompt = buildModePrompt(context);
			expect(prompt).toContain("默认验收是元素验证，不截图");
			expect(prompt).toContain("模型支持图片也不改变这个默认");
			expect(prompt).toContain("停止重复验证");
			expect(prompt).toContain("元素验证不等于完整视觉验收");
		}
	});
	test("screenshots remain available only on explicit user requests", () => {
		const prompt = buildModePrompt({
			mode: "agent",
			permission: "auto",
			interactive: true,
			pluginTools: ["browser_screenshot"],
		});
		expect(prompt).toContain("browser_screenshot 仅在用户明确要求截图或图片对比时使用");
	});

	test("the policy is absent without the tool", () => {
		const prompt = buildModePrompt({ mode: "agent", permission: "auto", interactive: true });
		expect(prompt).not.toContain("browser_screenshot 仅在用户明确要求截图或图片对比时使用");
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


describe("work stage title discipline", () => {
	test("overview requests have explicit scope and stop rules across interactive modes", () => {
		for (const mode of WORK_MODES) {
			const prompt = buildModePrompt({ ...base, mode });
			expect(prompt).toContain("## 项目概览的范围与停止条件");
			expect(prompt).toContain("默认不为概览运行测试、启动服务、检查远端 CI、追溯 Git 历史、创建临时副本或工作树");
			expect(prompt).toContain("已经判断“信息足够”“准备总结”后，直接给出概览");
			expect(prompt).toContain("用户明确要求深入审查、测试、排障或实现时，按其明确范围处理");
			expect(prompt).toContain("项目概览的交付物是解释");
			expect(prompt).toContain("即使当前处于 execute/debug 阶段");
			expect(prompt).toContain("“只读”“没有风险”“顺便确认一下”“有助于报告”都不是概览中主动执行命令的理由");
			expect(prompt).toContain("不要主动执行 git status、git diff、git log、git show、git check-ignore");
			expect(prompt).toContain("“如何运行”→解释文档里的启动步骤，不等于实际启动");
			expect(prompt).toContain("不要把概览纪律套用到明确的执行请求上");
		}
	});
	test("overview behavior guidance leaves execution tools available", () => {
		const context: PromptContext = { ...base, mode: "agent", phase: "execute", shellTools: ["powershell", "cmd"] };
		const prompt = buildModePrompt(context);
		expect(prompt).toContain("这是主动选工具的行为纪律，不是移除工具或新增权限拦截");
		const tools = toolsForMode(context);
		for (const name of ["powershell", "cmd", "read", "grep", "edit", "write", "switch_mode"])
			expect(tools).toContain(name);
	});
	test("interactive sessions receive action-title instructions", () => {
		for (const mode of WORK_MODES) {
			const prompt = buildModePrompt({ ...base, mode });
			expect(prompt).toContain("## 工作阶段标题");
			expect(prompt).toContain("### 读取项目入口");
			expect(prompt).toContain("再调用工具");
			expect(prompt).toContain("最终答复按任务正常组织");
			expect(prompt).toContain("不能只给第一个阶段写标题");
			expect(prompt).toContain("不因技能文件、工具结果或内部思考使用英文而切换语言");
			expect(prompt).toContain("追踪请求入口与路由分发");
			expect(prompt).toContain("不把几十次调用一直塞在“读取项目入口”下面");
			expect(prompt).toContain("不按调用数量切段，不为凑阶段增加调查");
		}
	});
	test("custom prompts retain the runtime UI convention", () => {
		configureCustomPrompt(() => "My custom instructions");
		try {
			const prompt = buildModePrompt({ ...base, mode: "agent" });
			expect(prompt).toContain("## 工作阶段标题");
			expect(prompt).toContain("## 项目概览的范围与停止条件");
		}
		finally { configureCustomPrompt(() => null); }
	});
	test("does not add UI narration to workers, automation or structured Fusion stages", () => {
		for (const extra of [{ child: true }, { headless: true }, { fastContext: true }, { interactive: false }]) {
			const prompt = buildModePrompt({ ...base, mode: "agent", ...extra });
			expect(prompt).not.toContain("## 工作阶段标题");
			expect(prompt).not.toContain("## 项目概览的范围与停止条件");
		}
		expect(buildModePrompt({ ...base, mode: "agent", fusionEngineInstructions: "Structured stage" })).toBe("Structured stage");
	});
});
