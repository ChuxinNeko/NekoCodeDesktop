import type {
	Automation,
	AutomationEvent,
	AutomationRun,
	AutomationWithState,
	SaveAutomationRequest,
} from "../../shared/automation";
import { validateAutomationInput } from "../../shared/automation";
import { nextOccurrence } from "../../shared/automationSchedule";
import { AutomationStore } from "./store";
import { AutomationRunner, type AutomationRunnerOptions, type AutomationRunOutcome } from "./runner";

/** How often the scheduler re-checks for due automations. */
const TICK_MS = 20_000;

/** The slice of AutomationRunner the scheduler needs, so tests can substitute it. */
export interface AutomationRunnerLike {
	run(automation: Automation, signal: AbortSignal): Promise<AutomationRunOutcome>;
}

export interface AutomationServiceOptions {
	userDataDir: string;
	sessionsDir: string;
	getModelRuntime: AutomationRunnerOptions["getModelRuntime"];
	onEvent: (event: AutomationEvent) => void;
	/** Overridable for tests; defaults to a real PI-backed runner. */
	runner?: AutomationRunnerLike;
	/** Overridable for tests; defaults to Date.now. */
	now?: () => number;
}

/**
 * Owns automation definitions, the timer that fires them, and their run history.
 *
 * A single tick timer asks "what is due now?" rather than holding one timer per
 * automation: it survives sleep/resume (a missed window fires on the next tick),
 * and definitions can be edited without reconciling timer handles.
 */
export class AutomationService {
	private readonly store: AutomationStore;
	private readonly runner: AutomationRunnerLike;
	private readonly onEvent: (event: AutomationEvent) => void;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly running = new Set<string>();
	private readonly aborts = new Map<string, AbortController>();

	constructor(options: AutomationServiceOptions) {
		this.store = new AutomationStore(options.userDataDir);
		this.runner =
			options.runner ??
			new AutomationRunner({
				sessionsDir: options.sessionsDir,
				getModelRuntime: options.getModelRuntime,
			});
		this.onEvent = options.onEvent;
		this.now = options.now ?? (() => Date.now());
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.runDueAutomations();
		}, TICK_MS);
		// A run scheduled while the app was closed should not wait a full tick.
		void this.runDueAutomations();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		for (const controller of this.aborts.values()) controller.abort();
		this.aborts.clear();
	}

	list(): AutomationWithState[] {
		const now = this.now();
		return this.store.list().map((automation) => this.withState(automation, now));
	}

	get(id: string): AutomationWithState | undefined {
		const automation = this.store.get(id);
		return automation ? this.withState(automation, this.now()) : undefined;
	}

	runs(id: string): AutomationRun[] {
		return this.store.readRuns(id).reverse();
	}

	save(request: SaveAutomationRequest): AutomationWithState {
		validateAutomationInput(request);
		const existing = request.id ? this.store.get(request.id) : undefined;
		const now = this.now();
		const automation: Automation = {
			id: existing?.id ?? this.store.newId(),
			name: request.name.trim(),
			cwd: request.cwd,
			prompt: request.prompt,
			modelKey: request.modelKey,
			mode: request.mode,
			schedule: request.schedule,
			enabled: request.enabled,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		this.store.upsert(automation);
		this.onEvent({ kind: "changed", automationId: automation.id });
		return this.withState(automation, now);
	}

	remove(id: string): void {
		this.aborts.get(id)?.abort();
		this.store.remove(id);
		this.onEvent({ kind: "changed", automationId: id });
	}

	/** Fire immediately, ignoring the schedule. */
	async runNow(id: string): Promise<AutomationRun> {
		const automation = this.store.get(id);
		if (!automation) throw new Error("自动化不存在");
		return this.execute(automation);
	}

	abort(id: string): void {
		this.aborts.get(id)?.abort();
	}

	private withState(automation: Automation, now: number): AutomationWithState {
		const runs = this.store.readRuns(automation.id);
		const lastRun = runs.length > 0 ? (runs[runs.length - 1] ?? null) : null;
		const next =
			automation.enabled && !this.running.has(automation.id)
				? nextOccurrence(automation.schedule, new Date(now))
				: null;
		return {
			...automation,
			nextRunAt: next ? next.getTime() : null,
			lastRun,
			running: this.running.has(automation.id),
		};
	}

	/**
	 * One scheduler step: fire every enabled automation whose next occurrence has
	 * already passed. Public so tests can drive it without waiting on the timer.
	 */
	async runDueAutomations(): Promise<void> {
		const now = this.now();
		for (const automation of this.store.list()) {
			if (!automation.enabled) continue;
			if (this.running.has(automation.id)) continue;
			// A run is due when the schedule's next occurrence has already passed.
			// The reference point is the last run so a restart does not re-fire an
			// automation that already ran this window.
			const reference = this.lastRunStart(automation.id) ?? automation.createdAt;
			const due = nextOccurrence(automation.schedule, new Date(reference));
			if (!due || due.getTime() > now) continue;
			await this.execute(automation);
		}
	}

	private lastRunStart(automationId: string): number | null {
		const runs = this.store.readRuns(automationId);
		const last = runs[runs.length - 1];
		return last ? last.startedAt : null;
	}

	private async execute(automation: Automation): Promise<AutomationRun> {
		if (this.running.has(automation.id)) {
			throw new Error("该自动化正在运行");
		}
		this.running.add(automation.id);
		const controller = new AbortController();
		this.aborts.set(automation.id, controller);

		const run: AutomationRun = {
			id: this.store.newId(),
			automationId: automation.id,
			startedAt: this.now(),
			status: "running",
			summary: "",
			toolCalls: 0,
		};
		this.store.appendRun(run);
		this.onEvent({ kind: "run-started", automationId: automation.id });

		try {
			const outcome = await this.runner.run(automation, controller.signal);
			const finished: AutomationRun = {
				...run,
				finishedAt: this.now(),
				status: outcome.aborted ? "aborted" : outcome.failure ? "failed" : "succeeded",
				summary: outcome.summary,
				toolCalls: outcome.toolCalls,
				...(outcome.sessionFile === undefined ? {} : { sessionFile: outcome.sessionFile }),
				...(outcome.failure === undefined ? {} : { error: outcome.failure }),
			};
			this.store.updateRun(finished);
			return finished;
		} catch (error) {
			const finished: AutomationRun = {
				...run,
				finishedAt: this.now(),
				status: controller.signal.aborted ? "aborted" : "failed",
				error: error instanceof Error ? error.message : String(error),
			};
			this.store.updateRun(finished);
			return finished;
		} finally {
			this.running.delete(automation.id);
			this.aborts.delete(automation.id);
			this.onEvent({ kind: "run-finished", automationId: automation.id });
		}
	}
}
