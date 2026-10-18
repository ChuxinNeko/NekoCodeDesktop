import { describe, expect, test } from "bun:test";
import { groupWorkStages, workStageCompleted, workStageLabel, workStageTitle, workStageHasDetails } from "../../src/renderer/src/lib/workStages";
import { zhCN } from "../../src/renderer/src/i18n/locales/zh-CN";
import { en } from "../../src/renderer/src/i18n/locales/en";
import type { Language, TranslateFn } from "../../src/renderer/src/i18n";
import type { WorkItem } from "../../src/shared/transcript";
const thought = (id: string, thinking: string): WorkItem => ({ kind: "thinking", id: `${id}-thinking`, cell: { id, type: "assistant", thinking, text: "", streaming: false, timestamp: 0 } });
const tool = (id: string, toolName: string): WorkItem => ({ kind: "tool", id, cell: { id, type: "tool", toolName, toolCallId: id, args: {}, output: "original output", status: "done", timestamp: 0 } });

const translate = (language: Language = "zh-CN"): TranslateFn => (key, params) =>
	(language === "zh-CN" ? zhCN[key] : en[key]).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? name));
const labels = (items: WorkItem[], language: Language = "zh-CN") => groupWorkStages(items, language).map((stage) => workStageLabel(stage, translate(language)));
const read = (id: string, path: string): WorkItem => {
	const item = tool(id, "read");
	if (item.kind === "tool") item.cell.args = { path };
	return item;
};

describe("work stage timeline", () => {
	test("groups tools under the task they carry out and preserves order", () => {
		const items = [thought("a", "**检查项目入口**\n先读取文件。"), tool("r", "read"), tool("s", "bash"), thought("b", "### 实现时间线\n保留详情。"), tool("e", "edit")];
		const stages = groupWorkStages(items);
		expect(stages.map((stage) => stage.title)).toEqual(["检查项目入口", "实现时间线"]);
		expect(stages.map((stage) => stage.items.length)).toEqual([3, 2]);
		expect(stages.flatMap((stage) => stage.items)).toEqual(items);
	});
	test("splits explicit headings without dropping reasoning", () => {
		const text = "## 检查入口\n读取文件\n\n**验证修改**\n运行测试";
		const stages = groupWorkStages([thought("a", text), tool("t", "bash")]);
		expect(stages.map((stage) => stage.title)).toEqual(["检查入口", "验证修改"]);
		expect(stages.map((stage) => stage.items[0].kind === "thinking" ? stage.items[0].cell.thinking : "").join("\n")).toBe(text);
		expect(stages[1].items[1].id).toBe("t");
	});
	test("classifies tool-only runs, retaining errors and unknown tools", () => {
		const failed = tool("e", "edit");
		if (failed.kind === "tool") failed.cell.status = "error";
		const items = [tool("a", "read"), tool("b", "read"), tool("c", "bash"), failed, tool("m", "mcp_custom")];
		const stages = groupWorkStages(items);
		expect(stages).toHaveLength(2);
		expect(stages.map(stage => workStageLabel(stage, translate()))).toEqual(["检查实现与相关调用", "实现代码改动与行为"]);
		expect(stages.flatMap((stage) => stage.items)).toEqual(items);
	});
	test("same response commentary and notices remain with the task", () => {
		const thinking = thought("a", "检查组件");
		const message: WorkItem = { kind: "message", id: "a-message", cell: { id: "a", type: "assistant", text: "### 开始修改", thinking: "检查组件", streaming: false, timestamp: 0 } };
		const notice: WorkItem = { kind: "notice", id: "n", cell: { id: "n", type: "notice", text: "失败原因", level: "error", timestamp: 0 } };
		const stages = groupWorkStages([thinking, message, tool("e", "edit"), notice]);
		expect(stages).toHaveLength(1);
		expect(stages[0].title).toBe("开始修改");
		expect(stages[0].category).toBe("task");
	});
	test("keeps ids stable as streaming text grows or assistant id is persisted", () => {
		const a = groupWorkStages([thought("stream", "正在检查")]);
		const b = groupWorkStages([thought("saved", "正在检查组件入口\n更多内容"), tool("t", "read")]);
		expect(a[0].id).toBe(b[0].id);
	});
	test("uses the supplied tool purpose instead of a raw shell command", () => {
		const item = tool("shell", "bash");
		if (item.kind === "tool") item.cell.args = { command: "bun run build", description: "检查桌面端编译兼容性" };
		expect(groupWorkStages([item])[0].title).toBe("检查桌面端编译兼容性");
	});

	test("handles empty input and long prose without raw markdown labels", () => {
		expect(groupWorkStages([])).toEqual([]);
		expect(workStageTitle("\n**Inspecting components**\nDetails", "en")).toBe("Inspecting components");
		expect(workStageTitle("Inspect files. Then edit.", "en")).toBe("");
		expect(workStageTitle("### " + "长".repeat(200))).toBe("");
	});
});


describe("action-oriented work titles", () => {
	test("prefers an explicit heading over narrative text", () => {
		expect(workStageTitle("我先看一下。\n\n### 读取项目入口\n检查 package.json 的脚本。")).toBe("读取项目入口");
		expect(workStageTitle("### 运行回归测试\n执行三个测试文件，报告真实结果。")).toBe("运行回归测试");
	});
	test("never promotes an ordinary reply or reasoning sentence to a title", () => {
		for (const text of ["我先读取 package.json 确认测试命令。", "我们将先读取 package.json 确认测试命令。", "接下来，我会读取 package.json 确认测试命令。", "正在读取 package.json 确认测试命令。", "读取文件", "package.json", "Let's look at the entry point server.mjs, and the other modules."])
			expect(workStageTitle(text)).toBe("");
		const message: WorkItem = { kind: "message", id: "m", cell: { id: "m", type: "assistant", text: "我先读取 package.json。", thinking: "", streaming: false, timestamp: 0 } };
		const stages = groupWorkStages([message, read("r", "package.json")]);
		expect(workStageLabel(stages[0], translate())).toBe("检查项目入口与启动配置");
		expect(stages[0].items[0]).toBe(message);
		expect(message.cell.text).toBe("我先读取 package.json。");
	});
	test("keeps technical identifiers but respects the selected language", () => {
		expect(workStageTitle("### 读取 work_stage.ts")).toBe("读取 work_stage.ts");
		expect(workStageTitle("### 检查 API 与 iOS 兼容性")).toBe("检查 API 与 iOS 兼容性");
		expect(workStageTitle("### Inspect component layout", "en")).toBe("Inspect component layout");
		expect(workStageTitle("### Inspect component layout", "zh-CN")).toBe("");
		expect(workStageTitle("### 检查组件布局", "en")).toBe("");
	});
	test("does not turn a bare internal report cue into a new stage", () => {
		const items = [thought("a", "### 运行测试"), tool("t", "bash"), thought("b", "Report.")];
		const stages = groupWorkStages(items);
		expect(stages).toHaveLength(1);
		expect(stages[0].title).toBe("运行测试");
		expect(stages[0].items).toEqual(items);
	});

	test("a generic thought followed by a real progress heading still starts a new stage", () => {
		const message: WorkItem = { kind: "message", id: "b-message", cell: { id: "b", type: "assistant", text: "### 运行回归测试", thinking: "hmm", streaming: false, timestamp: 0 } };
		const stages = groupWorkStages([thought("a", "### 读取入口"), tool("r", "read"), thought("b", "hmm"), message, tool("t", "bash")]);
		expect(stages.map((stage) => stage.title)).toEqual(["读取入口", "运行回归测试"]);
	});

	test("wrap-up reasoning without another action stays in the previous stage", () => {
		const items = [thought("a", "### 运行测试"), tool("t", "bash"), thought("b", "Report briefly. Explain the actual results.")];
		const stages = groupWorkStages(items);
		expect(stages).toHaveLength(1);
		expect(stages[0].title).toBe("运行测试");
		expect(stages[0].items).toEqual(items);
	});

	test("does not pick a heading from a code example or show partial markup", () => {
		expect(workStageTitle("检查示例\n\n```md\n### 不是真正标题\n```\n\n### 运行测试")).toBe("运行测试");
		expect(workStageTitle("### ")).toBe("");
	});
});


describe("localized timeline title regression", () => {
	test("every stage in the reported mixed-language run has a concise Chinese label", () => {
		const items = [
			thought("a", "### 读取项目入口"), read("r1", "package.json"),
			thought("b", "**Follow the skill**\nRead the skill before proceeding."), read("r2", "C:\\skills\\SKILL.md"),
			thought("c", "Let's look at the entry point server.mjs, and the other modules"), read("r3", "src/server.mjs"),
			thought("d", "Read server.mjs, pool.mjs, and protocols.mjs structurally — maybe grep for key functions and routes."), tool("s1", "grep"),
			thought("e", "Let me read protocols.mjs and pool.mjs quickly (they're large)"), read("r4", "src/protocols.mjs"),
		];
		expect(labels(items)).toEqual(["读取项目入口"]);
		expect(groupWorkStages(items).flatMap((stage) => stage.items)).toEqual(items);
	});

	test("English UI uses localized tool labels and accepts concise English headings", () => {
		const items = [thought("a", "### Inspect project entry"), read("a1", "package.json"), thought("b", "I'll read the server now."), read("b1", "src/server.mjs")];
		expect(labels(items, "en")).toEqual(["Inspect project entry"]);
		expect(labels(items, "zh-CN")).toEqual(["检查项目入口与启动配置"]);
	});

	test("revalidates tool descriptions instead of allowing English or narrative to leak through", () => {
		const shell = tool("shell", "bash");
		if (shell.kind !== "tool") throw new Error("Expected tool");
		for (const description of ["Read the entire server and inspect every module in detail.", "Follow the skill", "我先运行测试，然后看看结果。", "### I will inspect everything", "Planning Next Step"]) {
			shell.cell.args = { description, command: "secret command should never be a stage title" };
			expect(labels([thought("a", "Let me run this."), shell])).toEqual(["检查命令执行结果"]);
		}
		shell.cell.args = { description: "验证构建兼容性" };
		expect(labels([thought("a", "Let me run this."), shell])).toEqual(["验证构建兼容性"]);
	});

	test("a same-response prose update cannot overwrite an intentional heading", () => {
		const message: WorkItem = { kind: "message", id: "a-message", cell: { id: "a", type: "assistant", text: "Let me inspect all the modules and report what I find.", thinking: "### 读取项目入口", streaming: false, timestamp: 0 } };
		expect(labels([thought("a", message.cell.thinking), message, read("r", "server.mjs")])).toEqual(["读取项目入口"]);
	});

	test("rejects conversational headings and generic internal cues too", () => {
		for (const text of ["### 我先读取项目入口", "### 接下来查看文件", "### 读取文件，然后检查结果", "### 读取文件。然后修改代码", "**Follow the skill**", "### Thinking", "### Planning Next Step", "### Let's look at server.mjs", "### I will read the server", "### " + "Inspect ".repeat(10)])
			expect(workStageTitle(text)).toBe("");
		expect(workStageTitle("### Let's read the server", "en")).toBe("");
		expect(workStageTitle("**Follow the skill**", "en")).toBe("");
	});

	test("code headings never split stages, even inside nested or mismatched fences", () => {
		const text = "### 读取示例\n````md\n### 示例标题\n```\n~~~\n**另一个示例**\n````\n继续读取";
		const stages = groupWorkStages([thought("a", text), read("r", "example.md")]);
		expect(stages).toHaveLength(1);
		expect(stages[0].title).toBe("读取示例");
		expect(stages[0].items[0].kind === "thinking" && stages[0].items[0].cell.thinking).toBe(text);
		expect(workStageTitle("    ### 缩进代码标题")).toBe("");
	});

	test("incomplete streamed headings use a safe fallback, then become the intended title", () => {
		expect(labels([thought("stream", "### ")])).toEqual([]);
		expect(labels([thought("stream", "**读取项目")])).toEqual(["梳理实现方案与约束"]);
		expect(labels([thought("saved", "### 读取项目入口")])).toEqual(["读取项目入口"]);
	});
});


describe("consecutive work phases", () => {
	test("the reported ten-row run stays one phase even when the final command fails", () => {
		const paths = ["SKILL.md", "README.md", "", "server.mjs", "pool.mjs", "protocols.mjs", "protocols.mjs", "protocols.mjs", "index.html"];
		const items = paths.flatMap((path, index) => [thought(`a${index}`, "Let me inspect the next file."), read(`r${index}`, path)]);
		const failed = tool("failed", "bash");
		if (failed.kind === "tool") failed.cell.status = "error";
		items.push(thought("exec", "Run a command."), failed);
		const stages = groupWorkStages(items);
		expect(stages).toHaveLength(1);
		expect(stages.map((stage) => workStageLabel(stage, translate()))).toEqual(["检查项目入口与启动配置"]);
		expect(stages[0].items.filter((item) => item.kind === "tool")).toHaveLength(10);
		expect(stages[0].items).toContain(failed);
		expect(stages.flatMap((stage) => stage.items)).toEqual(items);
	});

	test("reading and searching stay in one investigation despite response boundaries", () => {
		const items = [thought("a", "Read files"), read("r", "README.md"), thought("b", "Find references"), tool("s", "grep"), thought("c", "Read matches"), read("r2", "index.ts")];
		expect(labels(items)).toEqual(["检查项目入口与启动配置"]);
		expect(labels(items, "en")).toEqual(["Check project entry points and startup configuration"]);
	});

	test("real objectives still start phases and repeated headings do not", () => {
		const items = [thought("a", "### 了解项目结构"), read("r", "README.md"), thought("b", "### 了解项目结构"), read("r2", "index.ts"), thought("c", "### 修复请求处理"), tool("e", "edit"), thought("d", "### 运行回归测试"), tool("t", "bash")];
		expect(labels(items)).toEqual(["了解项目结构", "修复请求处理", "运行回归测试"]);
		expect(groupWorkStages(items).flatMap((stage) => stage.items)).toEqual(items);
	});

	test("per-file explicit headings and descriptions cannot recreate a dense file list", () => {
		const items = [thought("a", "### 读取 SKILL.md"), read("r", "SKILL.md"), thought("b", "### 读取 README.md"), read("r2", "README.md")];
		expect(labels(items)).toEqual(["检查实现与相关调用"]);
		const command = tool("cmd", "bash");
		if (command.kind === "tool") command.cell.args = {description: "检查项目入口"};
		expect(labels([command, thought("n", "Continue inspecting"), tool("cmd2", "bash")])).toEqual(["检查项目入口"]);
	});

	test("execution changes split an old investigation even without a heading", () => {
		const items = [thought("a", "Inspect files"), read("r", "README.md"), tool("e", "edit"), tool("cmd", "bash")];
		expect(labels(items)).toEqual(["检查实现与相关调用", "实现代码改动与行为"]);
		expect(groupWorkStages(items).flatMap((stage) => stage.items)).toEqual(items);
	});

	test("appending more file reads keeps the phase key and preserves failures", () => {
		const items = [thought("a", "Inspect files"), read("r", "a.ts")];
		const first = groupWorkStages(items)[0];
		const failed = read("r2", "b.ts");
		if (failed.kind === "tool") failed.cell.status = "error";
		const stages = groupWorkStages([...items, thought("b", "Inspect another file"), failed]);
		expect(stages).toHaveLength(1);
		expect(stages[0].id).toBe(first.id);
		expect(stages[0].items).toContain(failed);
	});
});


describe("mixed-tool continuation regression", () => {
 test("keeps consecutive inspection together but does not swallow later edits and checks", () => {
  const items: WorkItem[] = [thought("a", "### 读取探索技能与项目入口"), read("r1", "SKILL.md"), thought("b", "### 读取项目说明与配置"), read("r2", "README.md"), thought("c", "### 梳理服务端入口与路由"), read("r3", "server.mjs")];
  const initial = groupWorkStages(items);
  for (let i = 0; i < 40; i++) {
   items.push(thought(`tail-${i}`, "Continue inspecting the implementation."), tool(`tool-${i}`, ["bash", "grep", "read", "powershell"][i % 4]));
   const stages = groupWorkStages(items);
   expect(stages).toHaveLength(3);
   expect(stages[2].id).toBe(initial[2].id);
  }
  items.push(thought("edit", "Evaluating implementation details"), tool("edit", "edit"));
  expect(groupWorkStages(items)).toHaveLength(4);
  const verify = tool("verify", "bash");
  if (verify.kind === "tool") verify.cell.args = { command: "bun run typecheck" };
  items.push(verify);
  expect(labels(items)).toEqual(["读取探索技能与项目入口", "读取项目说明与配置", "梳理服务端入口与路由", "实现代码改动与行为", "检查类型与测试结果"]);
  expect(groupWorkStages(items).flatMap(stage => stage.items)).toEqual(items);
 });
});


describe("specific objectives without per-file stages", () => {
 test("keeps distinct goals from one progress response and preserves all detail text", () => {
  const text = "### 梳理项目用途与启动配置\n查看说明和配置。\n\n### 追踪请求入口与路由分发\n确认调用关系。\n\n### 分析协议转换与连接池协作\n查看协作边界。";
  const message: WorkItem = {kind:"message",id:"m",cell:{id:"m",type:"assistant",text,thinking:"",streaming:false,timestamp:0}};
  const stages=groupWorkStages([message,read("r","protocols.mjs"),read("r2","pool.mjs")]);
  expect(stages.map(stage=>stage.title)).toEqual(["梳理项目用途与启动配置","追踪请求入口与路由分发","分析协议转换与连接池协作"]);
  expect(stages.flatMap(stage=>stage.items).filter(item=>item.kind==='message').map(item=>item.cell.text).join('\n')).toBe(text);
  expect(stages[2].items.filter(item=>item.kind==='tool')).toHaveLength(2);
 });
 test("same-response thinking does not swallow later explicit progress objectives", () => {
  const text="### 梳理项目用途与启动配置\n查看配置。\n### 追踪请求入口与路由分发\n查看入口。";
  const message: WorkItem={kind:'message',id:'a-message',cell:{id:'a',type:'assistant',text,thinking:'Investigate the project.',streaming:false,timestamp:0}};
  expect(labels([thought('a',message.cell.thinking),message,read('r','server.mjs')])).toEqual(['梳理项目用途与启动配置','追踪请求入口与路由分发']);
 });
 test("repeated file headings merge while a goal mentioning an identifier remains meaningful", () => {
  const items=[thought('a','### 梳理项目用途与启动配置'),read('r','README.md'),thought('b','### 读取 package.json'),read('r2','package.json'),thought('c','### 追踪请求入口与路由分发'),read('r3','server.mjs'),thought('d','### 读取 server.mjs'),read('r4','server.mjs'),thought('e','### 分析协议转换与 protocols.mjs'),read('r5','protocols.mjs')];
  expect(labels(items)).toEqual(['梳理项目用途与启动配置','追踪请求入口与路由分发','分析协议转换与 protocols.mjs']);
  expect(groupWorkStages(items).flatMap(stage=>stage.items)).toEqual(items);
 });
});


describe("execution phases after a design heading", () => {
 const action = (id: string, name: string, args: Record<string, unknown> = {}): WorkItem => {
  const item = tool(id, name);
  if (item.kind === "tool") item.cell.args = args;
  return item;
 };
 test("splits the HTML example into design, implementation, browser checks, fixes and rechecks", () => {
  const items = [thought("plan", "### 设计方向与页面结构"), action("write", "write", {path:"whoami.html"}), action("body", "edit", {path:"whoami.html"}), action("open", "browser_navigate", {url:"http://127.0.0.1:8765/whoami.html"}), action("mobile", "browser_viewport"), action("click", "browser_action"), action("fix", "edit", {path:"whoami.html"}), action("reopen", "browser_navigate", {url:"http://127.0.0.1:8765/whoami.html"}), action("check", "browser_evaluate")];
  expect(labels(items)).toEqual(["设计方向与页面结构", "实现代码改动与行为", "检查界面布局与实际交互", "实现代码改动与行为", "检查界面布局与实际交互"]);
  const stages = groupWorkStages(items);
  expect(stages.flatMap(stage => stage.items)).toEqual(items);
  expect(stages[2].items.map(item => item.id)).toEqual(["open", "mobile", "click"]);
  expect(groupWorkStages([...items, action("desktop", "browser_viewport")]).map(stage => stage.id)).toEqual(stages.map(stage => stage.id));
 });
 test("detects real test commands without parsing code or arbitrary echoed text", () => {
  const base = [thought("plan", "### 设计方向与页面结构"), action("write", "write", {path:"page.html", content:"npm test"})];
  expect(labels([...base, action("echo", "bash", {command:'echo "npm test"'})])).toHaveLength(2);
  expect(labels([...base, action("test", "bash", {command:"npm run test"})])).toEqual(["设计方向与页面结构", "实现代码改动与行为", "检查类型与测试结果"]);
 });
 test("does not turn research browsing into page verification", () => {
  expect(labels([thought("plan", "### 设计方向与页面结构"), action("browse", "browser_navigate", {url:"https://example.com"}), action("read", "browser_evaluate")])).toEqual(["设计方向与页面结构"]);
 });
 test("provides English execution titles in English UI", () => {
  expect(labels([thought("plan", "### Page design"), action("write", "write", {path:"page.html"}), action("test", "bash", {command:"bun test"})], "en")).toEqual(["Page design", "Implement code changes and behavior", "Check types and test results"]);
 });
});


describe("explicit stage completion", () => {
 const complete: WorkItem = {kind:"message",id:"complete",cell:{id:"complete",type:"assistant",text:"当前阶段已完成。",thinking:"",streaming:false,timestamp:1}};
 const stage = (items: WorkItem[]) => ({id:"stage",title:"实现页面",category:"edit" as const,items});
 test("tool success, failure and reasoning gaps do not complete a stage", () => {
  const command = tool("cmd", "bash");
  expect(workStageCompleted(stage([command]))).toBe(false);
  if(command.kind === "tool") command.cell.status = "error";
  expect(workStageCompleted(stage([command, thought("next", "Continue fixing")]))).toBe(false);
 });
 test("requires completion after all tools and clears when the next action starts", () => {
  const command = tool("cmd", "bash");
  expect(workStageCompleted(stage([command, complete]))).toBe(true);
  expect(workStageCompleted(stage([command, complete, tool("next", "edit")]))).toBe(false);
  if(command.kind === "tool") command.cell.status = "running";
  expect(workStageCompleted(stage([command, complete]))).toBe(false);
 });
});


describe("balanced phase granularity and empty reasoning", () => {
 const action = (id: string, name: string, args: Record<string, unknown>): WorkItem => {
  const item = tool(id, name);
  if (item.kind === "tool") item.cell.args = args;
  return item;
 };
 test("empty reasoning has no expandable stage and yields immediately to real work", () => {
  for (const text of ["", " \n\t", "### "]) {
   const empty = thought("empty", text);
   expect(groupWorkStages([empty])).toEqual([]);
   expect(workStageHasDetails({ items: [empty] })).toBe(false);
   const stages = groupWorkStages([empty, read("entry", "package.json")]);
   expect(stages).toHaveLength(1);
   expect(workStageLabel(stages[0], translate())).toBe("检查项目入口与启动配置");
   expect(workStageHasDetails(stages[0])).toBe(true);
  }
 });
 test("consecutive reads and searches for related components merge across descriptions", () => {
  const items = [
   action("first", "bash", {command:"cat src/components/Sidebar.tsx", description:"检查侧栏与消息组件"}),
   thought("internal", "**Assessing token budget**"),
   action("second", "bash", {command:"rg onSend src/components", description:"检查消息与输入组件"}),
   read("third", "src/components/Composer.tsx"),
  ];
  expect(labels(items)).toEqual(["检查侧栏与消息组件"]);
  expect(groupWorkStages(items)[0].items).toEqual(items);
 });
 test("a realistic read-install-edit-check-build-results run has purposeful short phases", () => {
  const items = [
   thought("internal", "**Evaluating implementation details**"),
   action("read1", "bash", {cmd:"cat src/components/Transcript.tsx"}),
   action("search", "bash", {command:"rg render src/components/Markdown.tsx"}),
   action("theme", "read", {path:"src/components/beautiful-ui/foundation.css"}),
   action("install", "bash", {command:"npx shadcn@latest add https://www.beautifului.dev/r/chat-composer.json"}),
   action("edit1", "edit", {path:"src/components/Transcript.tsx"}),
   action("edit2", "edit", {path:"src/components/Markdown.tsx"}),
   action("types", "bash", {command:'PATH="/tmp/bun/bin:$PATH" bun run typecheck'}),
   action("test", "bash", {command:"bun test test/renderer/workStages.test.ts"}),
   action("build", "bash", {command:"bun run build"}),
   action("log", "bash", {command:"cat /tmp/build.log"}),
  ];
  const titles = labels(items);
  expect(titles).toEqual(["检查界面组件与调用关系", "检查主题变量与布局常量", "安装组件与项目依赖", "修改界面组件与交互", "检查类型与测试结果", "编译界面并检查构建结果", "读取构建结果与验证记录"]);
  expect(groupWorkStages(items).flatMap(stage => stage.items)).toEqual(items);
  expect(groupWorkStages(items)[4].items.map(item => item.id)).toEqual(["types", "test"]);
  expect(titles.every(title => /[\p{Script=Han}]/u.test(title) && title.length <= 32)).toBe(true);
  expect(titles.join(" ")).not.toMatch(/Evaluating|Assessing|Clarifying|cat |rg |typecheck|\.tsx/);
 });
 test("internal English statuses never become headings in either language", () => {
  for (const status of ["Evaluating implementation details", "Assessing token budget", "Clarifying source requirements", "Evaluating bun installation"]) {
   for (const language of ["zh-CN", "en"] as const) {
    expect(workStageTitle(`### ${status}`, language)).toBe("");
    expect(labels([thought("a", `### ${status}`), read("r", "src/components/Transcript.tsx")], language).join(" ")).not.toContain(status);
   }
  }
 });
});
