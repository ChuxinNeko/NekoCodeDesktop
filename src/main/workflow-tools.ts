import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { WORK_MODES, type WorkMode } from "../shared/workflow";
import type { WorkflowState } from "./workflow-state";

export interface WorkflowToolHost {
	state: WorkflowState;
	requestMode(mode: WorkMode, reason: string, signal?: AbortSignal): Promise<unknown>;
	debugLog(action: "status" | "read" | "clear"): Promise<unknown>;
	commitMessage(instructions: string, signal?: AbortSignal): Promise<string>;
}
function define<T extends TSchema>(
	name: string,
	description: string,
	parameters: T,
	action: (args: Static<T>, signal?: AbortSignal) => Promise<unknown>,
): ToolDefinition {
	return {
		name,
		label: name,
		description,
		promptSnippet: description,
		parameters,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			if (signal?.aborted) throw new Error("Tool call cancelled");
			const data = await action(params as Static<T>, signal);
			return {
				content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
				details: data,
			};
		},
	};
}
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const object = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export function createWorkflowTools(host: WorkflowToolHost): ToolDefinition[] {
	return [
		define(
			"question",
			"Ask the user one to three questions in an interactive card and wait for their answer. Cancellation is not approval.",
			object({
				title: text(200),
				questions: Type.Array(
					object({
						id: text(80),
						question: text(6000),
						options: Type.Array(
							object({ id: text(80), label: text(200), description: Type.Optional(text(2000)) }),
							{ maxItems: 6 },
						),
					}),
					{ minItems: 1, maxItems: 3 },
				),
			}),
			(args, signal) => host.state.ask(args.questions, args.title, signal),
		),
		define(
			"todo_write",
			"Replace the session's todo list. Preserve unfinished items unless deliberately cancelling them; report statuses truthfully.",
			object({
				todos: Type.Array(
					object({
						id: text(80),
						text: text(1000),
						status: Type.Union([
							Type.Literal("pending"),
							Type.Literal("in_progress"),
							Type.Literal("completed"),
							Type.Literal("cancelled"),
						]),
					}),
					{ maxItems: 40 },
				),
			}),
			async (args) => host.state.writeTodos(args.todos),
		),
		define(
			"switch_mode",
			"In the automatic Agent mode this selects the working phase (ask=answer, plan, agent=execute, debug, multitask=delegate); it applies immediately, asks the user nothing, and stays in Agent. In a manually pinned mode it requests a work-mode change and requires explicit user confirmation. Tools the new phase unlocks only appear on the next model step, so end this step after calling it. Never increases execution permissions. No running workers may remain.",
			object({
				mode: Type.Union(WORK_MODES.map((mode) => Type.Literal(mode))),
				reason: text(1000),
			}),
			(args, signal) => host.requestMode(args.mode, args.reason, signal),
		),
		define(
			"task",
			"Start a background task. explore is read-only; worker edits declared non-overlapping paths. Include plan, constraints and acceptance checks. No nested workers. Completion automatically resumes the parent. In Fusion this uses the configured Sidekick (one at a time); writablePaths=[\".\"] grants exclusive workspace ownership and shell for builds/tests. Outside Fusion, at most four workers, no shell; parent verifies commands.",
			object({
				description: text(200),
				prompt: text(30000),
				designSpec: Type.Optional(Type.String({ minLength: 1, maxLength: 16000,
					description: "For Fusion visual/UI/HTML/SVG tasks, Lead must provide the concrete visual design here before delegating: composition and dimensions, exact colors and their roles, typography/spacing, shapes and proportions, animation timings/pivots, responsive behavior, and observable acceptance criteria. For a small change specify only affected details and preserve the existing design. Sidekick implements this specification; it does not invent the art direction. Omit for nonvisual tasks." })),
				kind: Type.Union([Type.Literal("explore"), Type.Literal("worker")]),
				writablePaths: Type.Array(text(1000), { maxItems: 20 }),
			}),
			async (args) => host.state.startTask(args),
		),
		define(
			"task_status",
			"Inspect retained worker statuses and results. Do not poll repeatedly; completion notifications are automatic.",
			object({ id: Type.Optional(text(100)) }),
			async (args) => {
				const tasks = host.state.snapshot().tasks;
				if (!args.id) return tasks;
				const task = tasks.find((entry) => entry.id === args.id);
				if (!task) throw new Error("Unknown task id");
				return task;
			},
		),
		define(
			"task_cancel",
			"Cancel one running worker belonging to this session.",
			object({ id: text(100) }),
			async (args) => {
				host.state.cancelTask(args.id);
				return { cancelled: true, id: args.id };
			},
		),
		define(
			"debug_log",
			"Get, read, or clear this session's private NDJSON log file. This does not start an HTTP logging server.",
			object({
				action: Type.Union([Type.Literal("status"), Type.Literal("read"), Type.Literal("clear")]),
			}),
			(args) => host.debugLog(args.action),
		),
		define(
			"commit_message",
			"Generate a proposed Git commit message from the actual staged diff using an isolated PI helper. Does not stage, commit or publish.",
			object({ instructions: Type.Optional(Type.String({ maxLength: 2000 })) }),
			(args, signal) => host.commitMessage(args.instructions ?? "", signal),
		),
	];
}
