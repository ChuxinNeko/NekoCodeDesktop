import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowTask } from "../shared/workflow";

// Same bridge stand-in as the other renderer tests: importing dock panels must
// not reach for Electron's preload API.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { RightDock, taskTabId, taskIdOfTab } = await import("../renderer/src/components/dock/RightDock");
const { TaskDetailPanel } = await import("../renderer/src/components/dock/TaskDetailPanel");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const render = (element: ReturnType<typeof createElement>) =>
	renderToStaticMarkup(createElement(I18nProvider, { children: element }));

const now = Date.now();

const worker = (id: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask => ({
	id,
	description: "Scout " + id,
	kind: "explore",
	writablePaths: [],
	status: "running",
	startedAt: now - 30_000,
	steps: [
		{
			kind: "thinking",
			id: id + "-t1",
			text: "Two places define this.\nThe helper is the newer one.",
			startedAt: now - 30_000,
			endedAt: now - 29_500,
		},
		{
			kind: "tool",
			id: id + "-s1",
			toolName: "grep",
			args: '{"pattern":"useNow"}',
			output: "src/lib/elapsed.ts:12",
			status: "done",
			startedAt: now - 29_000,
			endedAt: now - 27_000,
		},
		{ kind: "message", id: id + "-m1", text: "Found it in the elapsed helper.", startedAt: now - 26_000 },
		{
			kind: "tool",
			id: id + "-s2",
			toolName: "read",
			args: '{"path":"src/lib/elapsed.ts"}',
			status: "running",
			startedAt: now - 25_000,
		},
	],
	...overrides,
});

/**
 * Only worker tabs, deliberately: a built-in tool tab renders its real panel,
 * and the terminal's xterm never settles without a live DOM, so putting one in
 * a static render hangs the suite rather than failing it.
 */
const dock = (
	tabs: Parameters<typeof RightDock>[0]["tabs"],
	active: Parameters<typeof RightDock>[0]["active"],
	tasks: WorkflowTask[],
) =>
	render(
		createElement(RightDock, {
			cwd: "/project",
			tabs,
			active,
			tasks,
			onSelect: () => {},
			onCloseTab: () => {},
			onCancelTask: () => {},
			onCloseDock: () => {},
		}),
	);

describe("dock tabs", () => {
	test("a worker tab is addressed by its own id", () => {
		expect(taskIdOfTab(taskTabId("abc"))).toBe("abc");
		expect(taskIdOfTab("terminal")).toBeNull();
	});

	test("with no tabs open the dock offers the tool menu", () => {
		const html = dock([], null, []);
		expect(html).toContain("dock-pane-visible");
		expect(html).toContain("Ctrl+`");
	});

	test("every open tab is listed and only the active one is shown", () => {
		const alpha = worker("alpha");
		const beta = worker("beta", { description: "Rewrite parser", kind: "worker" });
		const html = dock([taskTabId("alpha"), taskTabId("beta")], taskTabId("beta"), [alpha, beta]);

		// Both tabs named, so two workers are two things you can switch between.
		expect(html).toContain("Scout alpha");
		expect(html).toContain("Rewrite parser");
		// The menu is out of the way once a tab is showing.
		expect(html).toContain("dock-pane-hidden");
		// The inactive pane stays mounted but hidden, so its state survives.
		expect(html).toContain("invisible pointer-events-none");
		expect(html).toContain('aria-current="true"');
	});

	test("a worker tab falls back to a generic name before its task is known", () => {
		expect(dock([taskTabId("ghost")], taskTabId("ghost"), [])).toContain("子代理");
	});
});

describe("worker detail panel", () => {
	test("shows every call with its arguments and output, and what the worker said", () => {
		const html = render(createElement(TaskDetailPanel, { task: worker("alpha"), onCancel: () => {} }));

		expect(html).toContain("Scout alpha");
		expect(html).toContain("只读调查");
		expect(html).toContain("grep");
		expect(html).toContain("useNow");
		// The output is the part the compact card cannot show.
		expect(html).toContain("src/lib/elapsed.ts:12");
		expect(html).toContain("Found it in the elapsed helper.");
		// Running, so it offers to stop.
		expect(html).toContain("取消任务");
	});

	test("reasoning uses the same block the transcript does, and settles with a duration", () => {
		const html = render(createElement(TaskDetailPanel, { task: worker("alpha") }));
		// Closed, so it reports how long it took rather than counting up.
		expect(html).toContain("Thought for 0s");
		expect(html).not.toContain("Thinking for");
	});

	test("reasoning still open counts up and shows its newest line", () => {
		const live = worker("alpha", {
			steps: [
				{ kind: "thinking", id: "t", text: "First thought.\nStill weighing it.", startedAt: now - 4000 },
			],
		});
		const html = render(createElement(TaskDetailPanel, { task: live }));

		expect(html).toContain("Thinking for 4s");
		// Collapsed, the header carries the tail — the same trade the transcript makes.
		expect(html).toContain("Still weighing it.");
		expect(html).not.toContain("First thought.");
	});

	test("a worker with no steps yet says so instead of looking empty", () => {
		const running = render(
			createElement(TaskDetailPanel, { task: worker("a", { steps: [] }), onCancel: () => {} }),
		);
		expect(running).toContain("正在启动子会话");

		const done = render(
			createElement(TaskDetailPanel, {
				task: worker("a", { steps: [], status: "completed", endedAt: now }),
			}),
		);
		expect(done).toContain("尚未调用任何工具");
		expect(done).not.toContain("取消任务");
	});

	test("a tab whose worker is gone explains the absence", () => {
		expect(render(createElement(TaskDetailPanel, { task: null }))).toContain("运行过程不会保留");
	});
});
