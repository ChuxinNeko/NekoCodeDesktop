import { describe, expect, test } from "bun:test";
import { groupWorkStages, workStageTitle } from "../../src/renderer/src/lib/workStages";
import type { WorkItem } from "../../src/shared/transcript";
const thought = (id: string, thinking: string): WorkItem => ({ kind: "thinking", id: `${id}-thinking`, cell: { id, type: "assistant", thinking, text: "", streaming: false, timestamp: 0 } });
const tool = (id: string, toolName: string): WorkItem => ({ kind: "tool", id, cell: { id, type: "tool", toolName, toolCallId: id, args: {}, output: "original output", status: "done", timestamp: 0 } });

describe("work stage timeline", () => {
	test("groups tools under the task they carry out and preserves order", () => {
		const items = [thought("a", "**检查项目入口**\n先读取文件。"), tool("r", "read"), tool("s", "bash"), thought("b", "实现时间线。\n保留详情。"), tool("e", "edit")];
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
		expect(stages.map((stage) => stage.category)).toEqual(["read", "command", "edit", "tools"]);
		expect(stages.flatMap((stage) => stage.items)).toEqual(items);
	});
	test("same response commentary and notices remain with the task", () => {
		const thinking = thought("a", "检查组件");
		const message: WorkItem = { kind: "message", id: "a-message", cell: { id: "a", type: "assistant", text: "开始修改", thinking: "检查组件", streaming: false, timestamp: 0 } };
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
		expect(workStageTitle("\n**Inspecting components**\nDetails")).toBe("Inspecting components");
		expect(workStageTitle("Inspect files. Then edit.")).toBe("Inspect files");
		expect(workStageTitle("x".repeat(200))).toHaveLength(96);
	});
});


describe("action-oriented work titles", () => {
	test("prefers an explicit heading over narrative text", () => {
		expect(workStageTitle("我先看一下。\n\n### 读取项目入口\n检查 package.json 的脚本。")).toBe("读取项目入口");
		expect(workStageTitle("### 运行回归测试\n执行三个测试文件，报告真实结果。")).toBe("运行回归测试");
	});
	test("normalizes legacy first-person updates without changing the stored message", () => {
		for (const text of ["我先读取 package.json 确认测试命令。", "我们将先读取 package.json 确认测试命令。", "接下来，我会读取 package.json 确认测试命令。", "正在读取 package.json 确认测试命令。"])
			expect(workStageTitle(text)).toBe("读取 package.json 确认测试命令");
		const message: WorkItem = { kind: "message", id: "m", cell: { id: "m", type: "assistant", text: "我先读取 package.json。", thinking: "", streaming: false, timestamp: 0 } };
		const stages = groupWorkStages([message, tool("r", "read")]);
		expect(stages[0].title).toBe("读取 package.json");
		expect(stages[0].items[0]).toBe(message);
		expect(message.cell.text).toBe("我先读取 package.json。");
	});
	test("keeps filenames, possessives and non-Chinese action titles intact", () => {
		expect(workStageTitle("### 读取 work_stage.ts")).toBe("读取 work_stage.ts");
		expect(workStageTitle("我们的读取策略")).toBe("我们的读取策略");
		expect(workStageTitle("现在的读取策略")).toBe("现在的读取策略");
		expect(workStageTitle("iOS compatibility")).toBe("iOS compatibility");
		expect(workStageTitle("package.json")).toBe("package.json");
		expect(workStageTitle("I'll first read package.json.")).toBe("Read package.json");
		expect(workStageTitle("Let me run the regression tests.")).toBe("Run the regression tests");
		expect(workStageTitle("### Inspect component layout")).toBe("Inspect component layout");
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
