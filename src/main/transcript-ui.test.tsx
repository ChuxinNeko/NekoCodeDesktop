import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentCell } from "../shared/agent";
import type { CheckpointSummary } from "../shared/checkpoints";
import type { WorkflowTask } from "../shared/workflow";

// Same bridge stand-in as the other renderer tests: importing a transcript
// component must not reach for Electron's preload API.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { Transcript } = await import("../renderer/src/components/Transcript");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const render = (
	cells: AgentCell[],
	streaming = false,
	tasks?: WorkflowTask[],
	checkpoints?: CheckpointSummary[],
) =>
	renderToStaticMarkup(
		createElement(I18nProvider, {
			children: createElement(Transcript, {
				cells,
				streaming,
				tasks,
				checkpoints,
				onRestoreCheckpoint: checkpoints ? () => {} : undefined,
			}),
		}),
	);

const now = Date.now();

const cells = {
	user: {
		id: "u1",
		type: "user",
		text: "ship it",
		timestamp: now - 60_000,
	} satisfies AgentCell,
	thinking: {
		id: "a1",
		type: "assistant",
		text: "",
		thinking: "weighing the options",
		streaming: false,
		timestamp: now - 59_000,
		thinkingStartedAt: now - 59_000,
		thinkingEndedAt: now - 55_000,
	} satisfies AgentCell,
	tool: {
		id: "t1",
		type: "tool",
		toolCallId: "t1",
		toolName: "bash",
		args: { command: "bun test" },
		output: "180 pass",
		status: "done",
		startedAt: now - 55_000,
		timestamp: now - 40_000,
	} satisfies AgentCell,
	answer: {
		id: "a2",
		type: "assistant",
		text: "Tests pass.",
		thinking: "",
		streaming: false,
		timestamp: now - 39_000,
	} satisfies AgentCell,
};

describe("transcript work grouping", () => {
	test("a finished run reports the time it took and opens expanded", () => {
		const html = render([cells.user, cells.thinking, cells.tool, cells.answer]);

		expect(html).toContain("Worked for 20s");
		expect(html).toContain('aria-expanded="true"');
		// Expanded: the steps are in the tree, and the answer is outside the group.
		expect(html).toContain("bash");
		expect(html).toContain("Thought for 4s");
		expect(html).toContain("Tests pass.");
		expect(html).not.toContain("tool call");
	});

	test("a running turn counts up and owns the waiting line", () => {
		const html = render([cells.user, cells.thinking, cells.tool], true);

		expect(html).toContain("Working for");
		expect(html).toContain("Planning Next Step");
	});

	test("a task row shows the worker it started, not the acknowledgement JSON", () => {
		const taskCell: AgentCell = {
			id: "t2",
			type: "tool",
			toolCallId: "t2",
			toolName: "task",
			args: { description: "Scout the layout", kind: "explore" },
			output: JSON.stringify({ id: "worker-1", status: "running" }),
			status: "done",
			startedAt: now - 50_000,
			timestamp: now - 50_000,
		};
		const task: WorkflowTask = {
			id: "worker-1",
			description: "Scout the layout",
			kind: "explore",
			writablePaths: [],
			status: "running",
			startedAt: now - 50_000,
			steps: [
				{
					kind: "tool",
					id: "s1",
					toolName: "grep",
					args: '{"pattern":"useNow"}',
					status: "done",
					startedAt: now - 49_000,
					endedAt: now - 47_000,
				},
				{
					kind: "tool",
					id: "s2",
					toolName: "read",
					args: '{"path":"src/app.ts"}',
					status: "running",
					startedAt: now - 47_000,
				},
			],
		};
		const html = render([cells.user, taskCell], true, [task]);

		expect(html).toContain("Scout the layout");
		expect(html).toContain("只读调查");
		// The worker's own tool calls, which the parent's transcript never sees.
		expect(html).toContain("grep");
		expect(html).toContain("src/app.ts");
		expect(html).not.toContain("worker-1");
	});
	test("a worker that is only reasoning says so rather than looking stalled", () => {
		const taskCell: AgentCell = {
			id: "t4",
			type: "tool",
			toolCallId: "t4",
			toolName: "task",
			args: { description: "Scout", kind: "explore" },
			output: JSON.stringify({ id: "worker-2" }),
			status: "done",
			timestamp: now - 10_000,
		};
		const task: WorkflowTask = {
			id: "worker-2",
			description: "Scout",
			kind: "explore",
			writablePaths: [],
			status: "running",
			startedAt: now - 10_000,
			steps: [
				{
					kind: "thinking",
					id: "th",
					text: "Looking for the entry point.\nTrying the router first.",
					startedAt: now - 9_000,
				},
			],
		};
		const html = render([cells.user, taskCell], true, [task]);

		// The summary carries one line of it; the whole stream is in the dock.
		expect(html).toContain("Trying the router first.");
		expect(html).not.toContain("Looking for the entry point.");
		expect(html).not.toContain("正在启动子会话");
	});
	test("a task row falls back to a plain tool row when the worker is unknown", () => {
		const orphan: AgentCell = {
			id: "t3",
			type: "tool",
			toolCallId: "t3",
			toolName: "task",
			args: { description: "Gone" },
			output: JSON.stringify({ id: "missing" }),
			status: "done",
			timestamp: now,
		};
		const html = render([cells.user, orphan], false, []);
		expect(html).toContain("task");
		expect(html).not.toContain("只读调查");
	});
	test("a turn that only thought keeps its single level", () => {
		const html = render([
			cells.user,
			{ ...cells.thinking, text: "Sure." } satisfies AgentCell,
		]);

		expect(html).toContain("Thought for 4s");
		expect(html).not.toContain("Worked for");
	});
});

describe("transcript checkpoints", () => {
	const checkpoint = (cellId: string | null): CheckpointSummary => ({
		id: "cp1",
		sessionId: "s1",
		createdAt: now - 61_000,
		label: "ship it",
		cellId,
		conversationRestorable: true,
		codeRestorable: true,
		fileCount: 12,
		additions: 30,
		deletions: 4,
		shellRuns: 0,
	});

	test("the prompt a checkpoint guards offers the rewind", () => {
		const html = render([cells.user, cells.answer], false, undefined, [checkpoint(cells.user.id)]);

		expect(html).toContain("回退到这里");
		expect(html).toContain("回退到「ship it」之前的检查点");
	});

	test("a checkpoint with no cell of its own stays out of the transcript", () => {
		// Compacted away, or on a branch the conversation has moved off: still a
		// valid restore point, but there is no row here that means "before this".
		const html = render([cells.user, cells.answer], false, undefined, [checkpoint(null)]);

		expect(html).not.toContain("回退到这里");
	});

	test("with no checkpoints the prompt renders exactly as it did before", () => {
		expect(render([cells.user, cells.answer])).not.toContain("回退到这里");
	});

	test("the rewind is disabled while the turn is still running", () => {
		const html = render([cells.user], true, undefined, [checkpoint(cells.user.id)]);

		expect(html).toContain("回退到这里");
		expect(html).toContain("disabled");
	});
});

describe("transcript file edit cards", () => {
	const editTool: AgentCell = {
		id: "t5",
		type: "tool",
		toolCallId: "t5",
		toolName: "edit",
		args: {
			path: "src/app.ts",
			edits: [{ oldText: "const a = 1;", newText: "const a = 2;\nconst b = 3;" }],
		},
		output: "Successfully replaced 1 block(s) in src/app.ts.",
		details: { diff: "-1 const a = 1;\n+1 const a = 2;\n+2 const b = 3;" },
		status: "done",
		startedAt: now - 55_000,
		timestamp: now - 40_000,
	};

	test("an edit result renders as a file card with stats and code lines", () => {
		const html = render([cells.user, editTool, cells.answer]);

		expect(html).toContain("app.ts");
		expect(html).toContain("+2");
		expect(html).toContain("−1");
		expect(html).toContain("const a = 1;");
		expect(html).toContain("const a = 2;");
		expect(html).toContain("const b = 3;");
	});

	test("an edit with no result details falls back to the args diff", () => {
		const html = render([
			cells.user,
			{ ...editTool, id: "t6", toolCallId: "t6", details: undefined },
		]);

		expect(html).toContain("app.ts");
		expect(html).toContain("+2");
		expect(html).toContain("−1");
		expect(html).toContain("const a = 1;");
		expect(html).toContain("const a = 2;");
	});

	test("a write renders its whole content as additions", () => {
		const writeTool: AgentCell = {
			id: "t7",
			type: "tool",
			toolCallId: "t7",
			toolName: "write",
			args: { path: "notes/todo.md", content: "buy milk\nfeed cat\n" },
			output: "wrote notes/todo.md",
			status: "done",
			startedAt: now - 55_000,
			timestamp: now - 40_000,
		};
		const html = render([cells.user, writeTool]);

		expect(html).toContain("todo.md");
		expect(html).toContain("+2");
		expect(html).not.toContain("−0");
		expect(html).toContain("buy milk");
		expect(html).toContain("feed cat");
	});

	test("a failed edit keeps the generic tool row", () => {
		const html = render([
			cells.user,
			{ ...editTool, id: "t8", toolCallId: "t8", status: "error" as const },
		]);

		expect(html).toContain("edit");
		expect(html).not.toContain("+2");
	});
});
