import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentCell } from "../shared/agent";
import type { WorkflowTask } from "../shared/workflow";

// Same bridge stand-in as the other renderer tests: importing a transcript
// component must not reach for Electron's preload API.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { Transcript } = await import("../renderer/src/components/Transcript");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const render = (cells: AgentCell[], streaming = false, tasks?: WorkflowTask[]) =>
	renderToStaticMarkup(
		createElement(I18nProvider, {
			children: createElement(Transcript, { cells, streaming, tasks }),
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
