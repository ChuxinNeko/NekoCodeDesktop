import { describe, expect, test } from "bun:test";
import { groupWorkStages, workStageLabel, workStageTitle } from "../../src/renderer/src/lib/workStages";
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
		expect(stages).toHaveLength(1);
		expect(workStageLabel(stages[0], translate())).toBe("处理任务");
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
		expect(workStageLabel(stages[0], translate())).toBe("读取 package.json");
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
		expect(labels(items, "zh-CN")).toEqual(["读取文件"]);
	});

	test("revalidates tool descriptions instead of allowing English or narrative to leak through", () => {
		const shell = tool("shell", "bash");
		if (shell.kind !== "tool") throw new Error("Expected tool");
		for (const description of ["Read the entire server and inspect every module in detail.", "Follow the skill", "我先运行测试，然后看看结果。", "### I will inspect everything", "Planning Next Step"]) {
			shell.cell.args = { description, command: "secret command should never be a stage title" };
			expect(labels([thought("a", "Let me run this."), shell])).toEqual(["执行命令"]);
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
		expect(labels([thought("stream", "### ")])).toEqual(["思考与规划"]);
		expect(labels([thought("stream", "**读取项目")])).toEqual(["思考与规划"]);
		expect(labels([thought("saved", "### 读取项目入口")])).toEqual(["读取项目入口"]);
	});
});


describe("coarse work phases", () => {
	test("the reported ten-row run stays one phase even when the final command fails", () => {
		const paths = ["SKILL.md", "README.md", "", "server.mjs", "pool.mjs", "protocols.mjs", "protocols.mjs", "protocols.mjs", "index.html"];
		const items = paths.flatMap((path, index) => [thought(`a${index}`, "Let me inspect the next file."), read(`r${index}`, path)]);
		const failed = tool("failed", "bash");
		if (failed.kind === "tool") failed.cell.status = "error";
		items.push(thought("exec", "Run a command."), failed);
		const stages = groupWorkStages(items);
		expect(stages).toHaveLength(1);
		expect(stages.map((stage) => workStageLabel(stage, translate()))).toEqual(["处理任务"]);
		expect(stages[0].items.filter((item) => item.kind === "tool")).toHaveLength(10);
		expect(stages[0].items).toContain(failed);
		expect(stages.flatMap((stage) => stage.items)).toEqual(items);
	});

	test("reading and searching stay in one investigation despite response boundaries", () => {
		const items = [thought("a", "Read files"), read("r", "README.md"), thought("b", "Find references"), tool("s", "grep"), thought("c", "Read matches"), read("r2", "index.ts")];
		expect(labels(items)).toEqual(["查看与检索"]);
		expect(labels(items, "en")).toEqual(["Inspecting and searching"]);
	});

	test("real objectives still start phases and repeated headings do not", () => {
		const items = [thought("a", "### 了解项目结构"), read("r", "README.md"), thought("b", "### 了解项目结构"), read("r2", "index.ts"), thought("c", "### 修复请求处理"), tool("e", "edit"), thought("d", "### 运行回归测试"), tool("t", "bash")];
		expect(labels(items)).toEqual(["了解项目结构", "修复请求处理", "运行回归测试"]);
		expect(groupWorkStages(items).flatMap((stage) => stage.items)).toEqual(items);
	});

	test("per-file explicit headings and descriptions cannot recreate a dense file list", () => {
		const items = [thought("a", "### 读取 SKILL.md"), read("r", "SKILL.md"), thought("b", "### 读取 README.md"), read("r2", "README.md")];
		expect(labels(items)).toEqual(["读取文件"]);
		const command = tool("cmd", "bash");
		if (command.kind === "tool") command.cell.args = {description: "检查项目入口"};
		expect(labels([command, thought("n", "Continue inspecting"), tool("cmd2", "bash")])).toEqual(["执行命令"]);
	});

	test("changing tool types without a new objective does not start a phase", () => {
		const items = [thought("a", "Inspect files"), read("r", "README.md"), tool("e", "edit"), tool("cmd", "bash")];
		expect(labels(items)).toEqual(["处理任务"]);
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
 test("keeps the three intentional objectives and absorbs an arbitrarily long alternating tail", () => {
  const items: WorkItem[] = [thought("a", "### 读取探索技能与项目入口"), read("r1", "SKILL.md"), thought("b", "### 读取项目说明与配置"), read("r2", "README.md"), thought("c", "### 梳理服务端入口与路由"), read("r3", "server.mjs")];
  const initial = groupWorkStages(items);
  for (let i = 0; i < 40; i++) {
   items.push(thought(`tail-${i}`, "Continue inspecting the implementation."), tool(`tool-${i}`, ["bash", "grep", "read", "powershell", "edit"][i % 5]));
   const stages = groupWorkStages(items);
   expect(stages).toHaveLength(3);
   expect(stages[2].id).toBe(initial[2].id);
   expect(stages[2].title).toBe("梳理服务端入口与路由");
  }
  expect(groupWorkStages(items).flatMap((stage) => stage.items)).toEqual(items);
  const failed = tool("failed", "bash");
  if (failed.kind === "tool") failed.cell.status = "error";
  items.push(thought("last", "Run verification."), failed);
  expect(groupWorkStages(items)[2].items).toContain(failed);
  expect(groupWorkStages(items)).toHaveLength(3);
  items.push(thought("verify", "### 验证改动结果"), tool("test", "bash"));
  expect(labels(items)).toEqual(["读取探索技能与项目入口", "读取项目说明与配置", "梳理服务端入口与路由", "验证改动结果"]);
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
