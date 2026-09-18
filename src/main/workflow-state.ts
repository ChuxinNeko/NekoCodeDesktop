import { randomUUID } from "node:crypto";
import type { ExecutionMode } from "../shared/agent";
import {
	isAgentPhase,
	isWorkMode,
	MAX_TASK_STEPS,
	MAX_WORKERS,
	type SavedWorkflowTask,
	type TaskInput,
	type TaskStep,
	type WorkMode,
	type WorkflowAnswer,
	type WorkflowQuestion,
	type WorkflowRequest,
	type WorkflowSavedState,
	type WorkflowSnapshot,
	type WorkflowTask,
	type WorkflowTodo,
} from "../shared/workflow";
import { pathsOverlap, resolveWorkspacePath } from "./workflow-paths";

export interface WorkflowStateOptions {
	cwd: string;
	getMode: () => WorkMode;
	getPermission: () => ExecutionMode;
	/** Whether background delegation is open right now — mode and phase decide. */
	canDelegate: () => boolean;
	maxWorkers?: () => number;
	onChange: () => void;
	onTaskComplete: (task: WorkflowTask) => Promise<void>;
	/** `onStep` reports the worker's tool calls so the parent can show them live. */
	runTask: (
		input: TaskInput,
		signal: AbortSignal,
		onStep: (step: TaskStep) => void,
	) => Promise<string>;
	saved?: unknown;
	taskTimeoutMs?: number;
}
function boundedText(value: unknown, max: number, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new Error("Invalid " + name);
	return value.trim();
}
export function validateTodos(value: unknown): WorkflowTodo[] {
	if (!Array.isArray(value) || value.length > 40) throw new Error("Expected at most 40 todos");
	const ids = new Set<string>();
	return value.map((entry) => {
		if (!entry || typeof entry !== "object") throw new Error("Invalid todo");
		const id = boundedText(entry.id, 80, "todo id");
		if (ids.has(id)) throw new Error("Duplicate todo id");
		ids.add(id);
		if (!["pending", "in_progress", "completed", "cancelled"].includes(entry.status))
			throw new Error("Invalid todo status");
		return { id, text: boundedText(entry.text, 1000, "todo text"), status: entry.status };
	});
}
export function readSavedWorkflow(value: unknown): WorkflowSavedState | undefined {
	try {
		const state = value as WorkflowSavedState;
		if (!state || state.version !== 1 || !isWorkMode(state.workMode)) return undefined;
		const todos = validateTodos(state.todos);
		const tasks: SavedWorkflowTask[] = Array.isArray(state.tasks)
			? state.tasks.slice(-24).flatMap((task) => {
					if (
						!task ||
						typeof task.id !== "string" ||
						typeof task.description !== "string" ||
						!["worker", "explore"].includes(task.kind) ||
						!["running", "completed", "failed", "cancelled"].includes(task.status) ||
						!Number.isFinite(task.startedAt)
					)
						return [];
					return [
						{
							...task,
							// Steps are live-only; anything claiming to be one in a session
							// file is stale at best.
							steps: undefined,
							description: task.description.slice(0, 200),
							writablePaths: [],
							status: task.status === "running" ? ("cancelled" as const) : task.status,
							result:
								task.status === "running"
									? "Session reopened; this worker was interrupted and was not resumed."
									: task.result?.slice(0, 12000),
						},
					];
				})
			: [];
		return {
			version: 1,
			workMode: state.workMode,
			...(isAgentPhase(state.phase) ? { phase: state.phase } : {}),
			todos,
			tasks,
		};
	} catch {
		return undefined;
	}
}
export class WorkflowState {
	private todos: WorkflowTodo[];
	private tasks: WorkflowTask[];
	private running = new Map<string, { controller: AbortController; scopes: string[] }>();
	private pending: {
		request: WorkflowRequest;
		settle: (answer: WorkflowAnswer) => void;
		abort: () => void;
	} | null = null;
	private closed = false;
	private jobs = new Map<string, Promise<void>>();
	constructor(private readonly options: WorkflowStateOptions) {
		const saved = readSavedWorkflow(options.saved);
		this.todos = saved?.todos ?? [];
		this.tasks = (saved?.tasks ?? []).map((task) => ({ ...task, steps: [] }));
	}
	snapshot(): WorkflowSnapshot {
		return structuredClone({
			maxWorkers: this.options.maxWorkers?.() ?? MAX_WORKERS,
			request: this.pending?.request ?? null,
			todos: this.todos,
			tasks: this.tasks,
		});
	}
	saved(): WorkflowSavedState {
		return {
			version: 1,
			workMode: this.options.getMode(),
			todos: structuredClone(this.todos),
			tasks: this.tasks.map(({ steps: _steps, ...task }) => structuredClone(task)),
		};
	}
	get hasRunningTasks(): boolean {
		return this.running.size > 0;
	}
	get hasPendingQuestion(): boolean {
		return this.pending !== null;
	}
	get hasWritingTasks(): boolean {
		return [...this.running.values()].some((entry) => entry.scopes.length > 0);
	}
	assertParentWrite(path: string): void {
		if (!this.hasWritingTasks) return;
		const target = resolveWorkspacePath(this.options.cwd, path);
		if (
			[...this.running.values()].some(({ scopes }) =>
				scopes.some((scope) => pathsOverlap(scope, target)),
			)
		)
			throw new Error("A worker owns this write scope; wait for or cancel it before editing.");
	}
	writeTodos(value: unknown): WorkflowTodo[] {
		if (this.closed) throw new Error("Workflow is closed");
		this.todos = validateTodos(value);
		this.options.onChange();
		return structuredClone(this.todos);
	}
	ask(
		questions: WorkflowQuestion[],
		title: string,
		signal?: AbortSignal,
		kind: WorkflowRequest["kind"] = "question",
	): Promise<WorkflowAnswer> {
		if (this.closed || signal?.aborted) return Promise.reject(new Error("Question cancelled"));
		if (this.pending)
			return Promise.reject(new Error("Another question is already awaiting the user"));
		if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3)
			throw new Error("Ask one to three questions");
		const ids = new Set<string>();
		for (const question of questions) {
			boundedText(question.id, 80, "question id");
			boundedText(question.question, 6000, "question");
			if (ids.has(question.id) || !Array.isArray(question.options) || question.options.length > 6)
				throw new Error("Invalid question options");
			ids.add(question.id);
			const optionIds = new Set<string>();
			for (const option of question.options) {
				boundedText(option.id, 80, "option id");
				boundedText(option.label, 200, "option label");
				if (optionIds.has(option.id)) throw new Error("Duplicate option id");
				optionIds.add(option.id);
			}
		}
		const request: WorkflowRequest = {
			id: randomUUID(),
			kind,
			title: boundedText(title, 200, "title"),
			questions: structuredClone(questions),
		};
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				signal?.removeEventListener("abort", abort);
				this.pending = null;
				this.options.onChange();
			};
			const abort = () => {
				cleanup();
				reject(new Error("Question cancelled"));
			};
			this.pending = {
				request,
				settle: (answer) => {
					cleanup();
					resolve(answer);
				},
				abort,
			};
			signal?.addEventListener("abort", abort, { once: true });
			this.options.onChange();
		});
	}
	answer(value: WorkflowAnswer): void {
		const pending = this.pending;
		if (!pending || !value || value.requestId !== pending.request.id)
			throw new Error("This question is no longer active");
		if (value.cancelled === true) {
			pending.settle({ requestId: value.requestId, answers: {}, cancelled: true });
			return;
		}
		if (!value.answers || typeof value.answers !== "object") throw new Error("Missing answers");
		const answers: WorkflowAnswer["answers"] = Object.create(null);
		for (const question of pending.request.questions) {
			const answer = value.answers[question.id];
			if (!answer || typeof answer !== "object") throw new Error("Missing answer: " + question.id);
			if (
				answer.optionId !== undefined &&
				!question.options.some((option) => option.id === answer.optionId)
			)
				throw new Error("Unknown option");
			const text = typeof answer.text === "string" ? answer.text.trim() : "";
			if (text.length > 6000 || (!answer.optionId && !text)) throw new Error("Invalid answer text");
			if (pending.request.kind === "mode-switch" && (!answer.optionId || text))
				throw new Error("Mode changes require an explicit option selection");
			answers[question.id] = {
				...(answer.optionId ? { optionId: answer.optionId } : {}),
				...(text ? { text } : {}),
			};
		}
		pending.settle({ requestId: value.requestId, answers });
	}
	startTask(input: TaskInput): WorkflowTask {
		if (this.closed || !this.options.canDelegate())
			throw new Error("Tasks require Multitask mode or the Agent delegate phase");
		const maxWorkers = this.options.maxWorkers?.() ?? MAX_WORKERS;
		if (this.running.size >= maxWorkers)
			throw new Error(maxWorkers === MAX_WORKERS ? "At most four workers may run concurrently" : `At most ${maxWorkers} workers may run concurrently`);
		boundedText(input.description, 200, "task description");
		boundedText(input.prompt, 30000, "task prompt");
		if (input.designSpec !== undefined) boundedText(input.designSpec, 16000, "visual design specification");
		if (input.kind !== "explore" && input.kind !== "worker") throw new Error("Invalid worker kind");
		if (input.kind === "worker" && this.options.getPermission() === "read-only")
			throw new Error("Write workers are disabled by read-only permission; use explore");
		if (!Array.isArray(input.writablePaths) || input.writablePaths.length > 20)
			throw new Error("Invalid writable paths");
		const scopes =
			input.kind === "worker"
				? input.writablePaths.map((value) =>
						resolveWorkspacePath(this.options.cwd, boundedText(value, 1000, "write path")),
					)
				: [];
		if (input.kind === "worker" && scopes.length === 0)
			throw new Error("A write worker must declare its writablePaths");
		if (
			scopes.some((scope) =>
				[...this.running.values()].some((entry) =>
					entry.scopes.some((other) => pathsOverlap(scope, other)),
				),
			)
		)
			throw new Error("Worker write scopes overlap; run these tasks sequentially");
		const task: WorkflowTask = {
			id: randomUUID(),
			description: input.description,
			kind: input.kind,
			writablePaths: input.kind === "worker" ? [...input.writablePaths] : [],
			status: "running",
			startedAt: Date.now(),
			steps: [],
		};
		const controller = new AbortController();
		this.running.set(task.id, { controller, scopes });
		this.tasks = [
			...this.tasks.filter(
				(entry) =>
					entry.status === "running" || this.tasks.indexOf(entry) >= this.tasks.length - 20,
			),
			task,
		];
		this.options.onChange();
		const timeout = setTimeout(
			() => {
				this.finishTask(task, "failed", "Worker timed out");
				controller.abort();
			},
			this.options.taskTimeoutMs ?? 30 * 60_000,
		);
		const job = Promise.resolve()
			.then(() => {
				if (controller.signal.aborted) throw new Error("Task cancelled");
				return this.options.runTask(structuredClone(input), controller.signal, (step) =>
					this.recordStep(task, step),
				);
			})
			.then(
				(result) => this.finishTask(task, "completed", result),
				(error: unknown) =>
					this.finishTask(task, "failed", error instanceof Error ? error.message : String(error)),
			)
			.finally(() => {
				clearTimeout(timeout);
				this.running.delete(task.id);
				this.jobs.delete(task.id);
				this.options.onChange();
			});
		this.jobs.set(task.id, job);
		return structuredClone(task);
	}
	/**
	 * Fold one of the worker's tool calls into its card, newest last.
	 *
	 * Upsert by the child's tool call id: a step arrives once when it starts and
	 * again when it ends, and the card should show one row that settles rather
	 * than two that disagree. Late steps from a worker that already finished are
	 * dropped — its card is its final report by then.
	 */
	private recordStep(task: WorkflowTask, step: TaskStep): void {
		if (this.closed || task.status !== "running") return;
		const at = task.steps.findIndex((entry) => entry.id === step.id);
		if (at >= 0) task.steps[at] = step;
		else {
			task.steps.push(step);
			if (task.steps.length > MAX_TASK_STEPS)
				task.steps.splice(0, task.steps.length - MAX_TASK_STEPS);
		}
		this.options.onChange();
	}
	/**
	 * Settle every step the worker left open.
	 *
	 * A worker killed mid-step leaves it running, and a spinner that never stops
	 * says it is still going. Both ways a task can end — reporting a result and
	 * being cancelled out from under itself — come through here, because the
	 * cancelled one is exactly the case that leaves steps dangling.
	 */
	private closeSteps(task: WorkflowTask, status: WorkflowTask["status"]): void {
		const at = Date.now();
		for (const step of task.steps) {
			if (step.kind === "thinking") step.endedAt ??= at;
			else if (step.kind === "tool" && step.status === "running") {
				step.status = status === "completed" ? "done" : "error";
				step.endedAt = at;
			}
		}
	}
	private finishTask(task: WorkflowTask, status: WorkflowTask["status"], result: string): void {
		if (task.status !== "running") return;
		this.closeSteps(task, status);
		task.status = status;
		task.result = result.slice(0, 12000);
		task.endedAt = Date.now();
		if (status !== "failed" || result !== "Worker timed out") this.running.delete(task.id);
		this.options.onChange();
		if (!this.closed)
			void this.options.onTaskComplete(structuredClone(task)).catch(() => {
				/* Result remains in the persisted task state. */
			});
	}
	cancelTask(id: string): void {
		const entry = this.running.get(id);
		const task = this.tasks.find((task) => task.id === id);
		if (!entry || !task || task.status !== "running") throw new Error("Task is not running");
		this.closeSteps(task, "cancelled");
		task.status = "cancelled";
		task.result = "Cancelled by user or parent session";
		task.endedAt = Date.now();
		entry.controller.abort();
		this.options.onChange();
	}
	abortAll(): void {
		this.pending?.abort();
		for (const id of [...this.running.keys()]) {
			if (this.tasks.find((task) => task.id === id)?.status === "running") this.cancelTask(id);
		}
	}
	async whenSettled(): Promise<void> {
		await Promise.all([...this.jobs.values()]);
	}
	dispose(): void {
		this.closed = true;
		this.abortAll();
	}
}
