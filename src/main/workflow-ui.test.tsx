import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentPhase, WorkflowSnapshot, WorkMode } from "../shared/workflow";

// The renderer normally receives this bridge from Electron preload. Rendering
// these controls on the server must not invoke IPC or require an Electron window.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { WorkflowPanel, isAnswered } = await import(
	"../renderer/src/components/chat/WorkflowPanel"
);
const { ComposerPickers } = await import("../renderer/src/components/chat/ComposerPickers");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const render = (element: ReturnType<typeof createElement>) =>
	renderToStaticMarkup(createElement(I18nProvider, { children: element }));
describe("workflow renderer", () => {
	test("renders a real question form with choices and standard code blocks", () => {
		const state: WorkflowSnapshot = {
			todos: [],
			tasks: [],
			request: {
				id: "request-1",
				kind: "question",
				title: "Choose a solution",
				questions: [
					{
						id: "q",
						question: "Review this code:\n\n```typescript\nconst x = 1;\n```",
						options: [{ id: "yes", label: "Approve" }],
					},
				],
			},
		};
		const html = render(createElement(WorkflowPanel, { workflow: state }));
		expect(html).toContain("<form");
		expect(html).toContain('type="radio"');
		expect(html).toContain("language-typescript");
		expect(html).toContain("Approve");
		expect(html).toContain("发送回答");
	});
	test("the title and the buttons sit outside the band the options scroll in", () => {
		const options = Array.from({ length: 12 }, (_, index) => ({
			id: `o${index}`,
			label: `Option ${index}`,
		}));
		const workflow: WorkflowSnapshot = {
			todos: [],
			tasks: [],
			request: {
				id: "long",
				kind: "question",
				title: "Choose a solution",
				questions: [{ id: "q", question: "Pick one", options }],
			},
		};
		const html = render(createElement(WorkflowPanel, { workflow }));
		const at = (needle: string) => html.indexOf(needle);
		const header = at('data-slot="question-header"');
		const scroll = at('data-slot="question-options"');
		const actions = at('data-slot="question-actions"');

		expect(header).toBeGreaterThan(-1);
		expect(header).toBeLessThan(scroll);
		expect(scroll).toBeLessThan(actions);
		// The choices are the part that scrolls: they fall between the scrolling
		// band and the button row, while the title and the buttons fall outside it.
		expect(at("Option 0")).toBeGreaterThan(scroll);
		expect(at("Option 11")).toBeLessThan(actions);
		expect(at("Choose a solution")).toBeLessThan(scroll);
		expect(at("发送回答")).toBeGreaterThan(actions);
		// Exactly one scroller in the card — a second one would mean the bands
		// moved back inside something that scrolls.
		const form = html.slice(at("<form"), at("</form>"));
		expect(form.split("overflow-y-auto").length - 1).toBe(1);
	});

	test("several questions arrive one page at a time", () => {
		const question = (id: string, label: string) => ({
			id,
			question: `Question ${id}`,
			options: [{ id: "a", label }],
		});
		const workflow: WorkflowSnapshot = {
			todos: [],
			tasks: [],
			request: {
				id: "multi",
				kind: "question",
				title: "Three decisions",
				questions: [question("q1", "First"), question("q2", "Second"), question("q3", "Third")],
			},
		};
		const html = render(createElement(WorkflowPanel, { workflow }));
		expect(html).toContain("1/3");
		// Only the page being answered is in the DOM — the other two are not
		// rendered offscreen, they are not rendered at all.
		expect(html).toContain("Question q1");
		expect(html).not.toContain("Question q2");
		expect(html).not.toContain("Question q3");
		// Forward on page one, and no way to submit before the last question.
		expect(html).toContain("下一步");
		expect(html).not.toContain("发送回答");
		// Nothing to go back to yet.
		expect(html).not.toContain("上一步");
	});

	test("a single question is not dressed up as a one-page wizard", () => {
		const workflow: WorkflowSnapshot = {
			todos: [],
			tasks: [],
			request: {
				id: "one",
				kind: "question",
				title: "One decision",
				questions: [{ id: "q", question: "Pick", options: [{ id: "a", label: "A" }] }],
			},
		};
		const html = render(createElement(WorkflowPanel, { workflow }));
		expect(html).toContain("发送回答");
		expect(html).not.toContain("下一步");
		expect(html).not.toContain("1/1");
		expect(html).not.toContain('data-slot="question-pager"');
	});

	test("progress gives way to a question instead of competing for the height", () => {
		const todos = [{ id: "t1", text: "Ship it", status: "pending" as const }];
		const request = {
			id: "r",
			kind: "question" as const,
			title: "Choose",
			questions: [{ id: "q", question: "Pick", options: [{ id: "a", label: "A" }] }],
		};
		const waiting = render(
			createElement(WorkflowPanel, { workflow: { todos, tasks: [], request } }),
		);
		const idle = render(
			createElement(WorkflowPanel, { workflow: { todos, tasks: [], request: null } }),
		);
		// Capped to a sliver while an answer is owed, and free to take the panel
		// once it is the only thing in it.
		expect(waiting).toContain("max-h-24");
		expect(idle).not.toContain("max-h-24");
	});

	test("what counts as an answer, and so what unlocks the next page", () => {
		// The gate on Next and on Send is this one predicate, so it is worth
		// pinning: typing instead of picking is a real answer, whitespace is not.
		expect(isAnswered({ q: { optionId: "a" } }, "q")).toBe(true);
		expect(isAnswered({ q: { text: "别的方案" } }, "q")).toBe(true);
		expect(isAnswered({ q: { text: "   " } }, "q")).toBe(false);
		expect(isAnswered({ q: { optionId: "", text: "" } }, "q")).toBe(false);
		expect(isAnswered({}, "q")).toBe(false);
	});

	test("mode confirmations have no free-text approval field", () => {
		const workflow: WorkflowSnapshot = {
			todos: [],
			tasks: [],
			request: {
				id: "mode-1",
				kind: "mode-switch",
				title: "Confirm mode",
				questions: [
					{
						id: "mode",
						question: "Switch?",
						options: [
							{ id: "approve", label: "Confirm" },
							{ id: "reject", label: "Decline" },
						],
					},
				],
			},
		};
		const html = render(createElement(WorkflowPanel, { workflow }));
		expect(html).toContain("Decline");
		expect(html).not.toContain("<textarea");
	});
	test("the worker pool shows every slot, taken or not", () => {
		const worker = (id: string, status: WorkflowSnapshot["tasks"][number]["status"]) => ({
			id,
			description: "Rewrite " + id,
			kind: "worker" as const,
			writablePaths: ["src/" + id + ".ts"],
			status,
			startedAt: Date.now() - 30_000,
			steps: [
				{
					kind: "tool" as const,
					id: id + "-s1",
					toolName: "edit",
					args: '{"path":"src/' + id + '.ts"}',
					status: "running" as const,
					startedAt: Date.now() - 20_000,
				},
			],
		});
		const workflow: WorkflowSnapshot = {
			todos: [],
			request: null,
			tasks: [worker("alpha", "running"), worker("beta", "running"), worker("gamma", "completed")],
		};
		const html = render(createElement(WorkflowPanel, { workflow }));

		// Two of four running — the ceiling is the part worth knowing.
		expect(html).toContain("2/4 个后台任务");
		expect(html).toContain("Rewrite alpha");
		expect(html).toContain("写入 worker");
		expect(html).toContain("可写范围");
		// The worker's live tool call, forwarded from its own session.
		expect(html).toContain("edit");
	});
	test("a worker opens while it runs and folds away once it is done", () => {
		const base = {
			id: "w",
			description: "Reopened worker",
			kind: "explore" as const,
			writablePaths: [],
			startedAt: Date.now() - 60_000,
			steps: [],
		};
		const panel = (tasks: WorkflowSnapshot["tasks"]) =>
			render(createElement(WorkflowPanel, { workflow: { todos: [], request: null, tasks } }));

		// Running: the one part of a turn the transcript cannot show, so it is open.
		const live = panel([{ ...base, status: "running" }]);
		expect(live).toContain("1/4 个后台任务");
		expect(live).toContain("正在启动子会话");

		// Finished and reopened: a reference, behind its header until asked for.
		const done = panel([
			{ ...base, status: "completed", endedAt: Date.now() - 30_000, result: "FINDINGS" },
		]);
		expect(done).toContain("0/4 个后台任务");
		expect(done).toContain("已完成");
		expect(done).not.toContain("FINDINGS");
	});
	const pickers = (workMode: WorkMode, agentPhase: AgentPhase) =>
		render(
			createElement(ComposerPickers, {
				models: [],
				modelKey: null,
				thinkingLevel: "off",
				thinkingLevels: ["off"],
				mode: "read-only",
				workMode,
				agentPhase,
				onSetMode: () => {},
				onSetWorkMode: () => {},
				onSetModel: () => {},
				onSetFusion: () => {},
				onSetThinking: () => {},
			}),
		);
	test("work mode and execution permission have separate selectors", () => {
		const html = pickers("plan", "execute");
		expect(html).toContain("Plan");
		expect(html).toContain("只读");
	});
	test("the automatic mode names the phase it matched to the task", () => {
		// The picker is the only place an automatic switch becomes visible, so it
		// has to report the phase rather than the mode the user pinned.
		expect(pickers("agent", "delegate")).toContain("Agent · 委派");
		expect(pickers("agent", "execute")).toContain("Agent · 执行");
		// A pinned mode has no phase to report.
		expect(pickers("debug", "execute")).not.toContain("执行");
	});
});
