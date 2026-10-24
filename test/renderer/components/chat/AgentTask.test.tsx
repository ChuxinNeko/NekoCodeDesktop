import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import {
	getStatusDotClassName,
	StepRow,
	TaskCard,
	WorkerSlots,
} from "../../../../src/renderer/src/components/chat/AgentTask";
import type { TaskStep, WorkflowTask } from "../../../../src/shared/workflow";

const render = (content: React.ReactNode) =>
	renderToString(<I18nProvider>{content}</I18nProvider>);

describe("getStatusDotClassName", () => {
	test("maps running, completed, failed, cancelled and outcomes to exact tokens", () => {
		expect(getStatusDotClassName("running")).toBe("bg-sky-500");
		expect(getStatusDotClassName("completed")).toBe("bg-emerald-500");
		expect(getStatusDotClassName("completed", "completed")).toBe("bg-emerald-500");
		expect(getStatusDotClassName("failed")).toBe("bg-destructive");
		expect(getStatusDotClassName("cancelled")).toBe("bg-amber-500");

		// Abnormal outcomes must be amber and never green
		expect(getStatusDotClassName("completed", "blocked")).toBe("bg-amber-500");
		expect(getStatusDotClassName("completed", "needs_decision")).toBe("bg-amber-500");
		expect(getStatusDotClassName("completed", "needs_escalation")).toBe("bg-amber-500");
		expect(getStatusDotClassName("completed", "blocked")).not.toBe("bg-emerald-500");
	});
});

describe("TaskCard default collapsed and summary line", () => {
	test("collapsed transcript shows a brief result while workflow rows avoid repeating it", () => {
		const task: WorkflowTask = {
			id: "t1",
			kind: "worker",
			description: "Execute unit test migrations",
			writablePaths: ["src/a.ts"],
			status: "completed",
			startedAt: 1000,
			endedAt: 5000,
			steps: [],
			result: "## Done\nAll tests passed with flying colors\nLong implementation details stay in the detail view",
		};
		const html = render(<TaskCard task={task} />);
		expect(html).toContain("Execute unit test migrations");
		expect(html).toContain("All tests passed with flying colors");
		expect(html).not.toContain("Long implementation details stay in the detail view");
		expect(html).not.toContain("src/a.ts");
		expect(render(<TaskCard task={task} variant="workflow" />)).not.toContain("All tests passed with flying colors");
	});

	test("running state when collapsed shows starting placeholder if steps are empty", () => {
		const task: WorkflowTask = {
			id: "t2",
			kind: "worker",
			description: "Starting task",
			writablePaths: [],
			status: "running",
			startedAt: 1000,
			steps: [],
		};
		const html = render(<TaskCard task={task} />);
		expect(html).toMatch(/启动中|Starting/);
	});

	test("running state when collapsed shows tool activity on latest step", () => {
		const task: WorkflowTask = {
			id: "t3",
			kind: "worker",
			description: "Running worker",
			writablePaths: [],
			status: "running",
			startedAt: 1000,
			steps: [
				{
					id: "s1",
					kind: "tool",
					toolName: "read",
					args: '{"path":"file.ts"}',
					status: "running",
					startedAt: 1000,
				},
			],
		};
		const html = render(<TaskCard task={task} />);
		expect(html).toContain("read");
		expect(html).toContain("file.ts");
	});

	test("running state when collapsed shows latest thinking line", () => {
		const task: WorkflowTask = {
			id: "t4",
			kind: "worker",
			description: "Running worker with thoughts",
			writablePaths: [],
			status: "running",
			startedAt: 1000,
			steps: [
				{
					id: "s1",
					kind: "thinking",
					text: "First thought line\nSecond thought line to focus",
					startedAt: 1000,
				},
			],
		};
		const html = render(<TaskCard task={task} />);
		expect(html).toContain("Second thought line to focus");
	});

	test("running state when collapsed shows message last line", () => {
		const task: WorkflowTask = {
			id: "t5",
			kind: "worker",
			description: "Worker with message",
			writablePaths: [],
			status: "running",
			startedAt: 1000,
			steps: [
				{
					id: "s1",
					kind: "message",
					text: "Hello world\nFinal message status line",
					startedAt: 1000,
				},
			],
		};
		const html = render(<TaskCard task={task} />);
		expect(html).toContain("Final message status line");
	});
});

describe("TaskCard expanded details", () => {
	test("when expanded, displays scope, tools, markdown result and gone notice", () => {
		const toolStep: Extract<TaskStep, { kind: "tool" }> = {
			id: "step-1",
			kind: "tool",
			toolName: "bash",
			args: "npm test",
			status: "done",
			startedAt: 1000,
			endedAt: 2000,
		};
		const task: WorkflowTask = {
			id: "t6",
			kind: "worker",
			description: "Detailed completed task",
			writablePaths: ["src/index.ts", "src/util.ts"],
			status: "completed",
			startedAt: 1000,
			endedAt: 4000,
			steps: [toolStep],
			result: "## Done\nTask completed **successfully**.",
		};
		const html = render(<TaskCard task={task} defaultOpen={true} />);
		expect(html).toContain("src/index.ts, src/util.ts");
		expect(html).toContain("npm test");
		expect(html).toContain("Task completed");
		expect(html).toContain("<strong>successfully</strong>");
	});

	test("when expanded and steps were live-only, shows steps gone notice", () => {
		const task: WorkflowTask = {
			id: "t7",
			kind: "worker",
			description: "Reopened task without steps",
			writablePaths: [],
			status: "completed",
			startedAt: 1000,
			endedAt: 2000,
			steps: [],
			result: "Only final outcome recorded",
		};
		const html = render(<TaskCard task={task} defaultOpen={true} />);
		expect(html).toMatch(/运行过程不会保留|The run is not kept/);
		expect(html).toContain("Only final outcome recorded");
	});
});

describe("TaskCard actions and accessibility", () => {
	test("cancel button is rendered only while running and when onCancel is provided", () => {
		const runningTask: WorkflowTask = {
			id: "t8",
			kind: "worker",
			description: "Terminable worker task",
			writablePaths: [],
			status: "running",
			startedAt: 1000,
			steps: [],
		};
		const htmlWithCancel = render(<TaskCard task={runningTask} onCancel={() => {}} />);
		expect(htmlWithCancel).toMatch(/取消任务|Cancel task/);

		const htmlWithoutCancel = render(<TaskCard task={runningTask} />);
		expect(htmlWithoutCancel).not.toMatch(/取消任务|Cancel task/);

		const completedTask: WorkflowTask = {
			...runningTask,
			status: "completed",
			endedAt: 2000,
		};
		const htmlCompleted = render(<TaskCard task={completedTask} onCancel={() => {}} />);
		expect(htmlCompleted).not.toMatch(/取消任务|Cancel task/);
	});

	test("status tone for failed task applies text-destructive", () => {
		const failedTask: WorkflowTask = {
			id: "t9",
			kind: "worker",
			description: "Failed execution",
			writablePaths: [],
			status: "failed",
			startedAt: 1000,
			endedAt: 2000,
			steps: [],
		};
		const html = render(<TaskCard task={failedTask} />);
		expect(html).toContain("text-destructive");
		expect(html).toContain("bg-destructive");
	});
});

describe("WorkerSlots and StepRow compatibility", () => {
	test("WorkerSlots renders correct total and active dots", () => {
		const html = render(<WorkerSlots running={2} max={4} />);
		expect(html).toContain("size-1.5");
		// 2 filled dots (bg-foreground/70) and 2 empty (bg-foreground/15)
		const filledCount = (html.match(/bg-foreground\/70/g) || []).length;
		const emptyCount = (html.match(/bg-foreground\/15/g) || []).length;
		expect(filledCount).toBe(2);
		expect(emptyCount).toBe(2);
	});

	test("StepRow renders tool step preview correctly", () => {
		const toolStep: Extract<TaskStep, { kind: "tool" }> = {
			id: "step-tool",
			kind: "tool",
			toolName: "grep",
			args: 'pattern="test"',
			status: "done",
			startedAt: 1000,
			endedAt: 3000,
		};
		const html = render(<StepRow step={toolStep} />);
		expect(html).toContain("grep");
		expect(html).toContain("test");
	});
});
