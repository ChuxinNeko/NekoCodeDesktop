import { AdaptiveRoutingPolicy, type RoutingPolicy } from "./routing-policy.js";
import type { FusionHooks } from "../hooks/CommandHookRunner.js";
import { FusionBudgetExceededError, RunBudgetGuard } from "./RunBudgetGuard.js";
import type {
  AgentRole,
  AgentRunner,
  AgentTurn,
  FusionEvent,
  FusionResult,
  FusionRunRequest,
  FusionUsage,
  FusionWorkerProfile,
  SessionRecord,
  SessionStore,
  TokenUsage,
  ToolActivityEvent,
} from "./types.js";

interface FusionEngineOptions {
  contextMessageLimit?: number;
  hooks?: FusionHooks;
  models: { main: string[]; sidekick: string[] };
  routingPolicy?: RoutingPolicy;
  runner: AgentRunner;
  store: SessionStore;
}

type EventListener = (event: FusionEvent) => void;

export class FusionEngine {
  readonly #contextMessageLimit: number;
  readonly #hooks: FusionHooks | undefined;
  #workerSequence = 0;
  readonly #routingPolicy: RoutingPolicy;
  readonly #runner: AgentRunner;
  readonly #store: SessionStore;

  constructor(options: FusionEngineOptions) {
    this.#hooks = options.hooks;
    this.#runner = options.runner;
    this.#store = options.store;
    this.#contextMessageLimit = options.contextMessageLimit ?? 24;
    this.#routingPolicy =
      options.routingPolicy ?? new AdaptiveRoutingPolicy(options.models);
  }

  async run(request: FusionRunRequest): Promise<FusionResult> {
    return this.#run(request, () => undefined);
  }

  async *stream(request: FusionRunRequest): AsyncGenerator<FusionEvent> {
    const queue = new AsyncEventQueue<FusionEvent>();
    void this.#run(request, (event) => queue.push(event))
      .catch(() => undefined)
      .finally(() => queue.close());
    for await (const event of queue) {
      yield event;
    }
  }

  async #run(
    request: FusionRunRequest,
    emit: EventListener,
  ): Promise<FusionResult> {
    const budget = new RunBudgetGuard(request.budget);
    try {
      return await this.#runGuarded(request, emit, budget);
    } finally {
      budget.close();
    }
  }

  async #runGuarded(
    request: FusionRunRequest,
    emit: EventListener,
    budget: RunBudgetGuard,
  ): Promise<FusionResult> {
    const session = await this.#loadSession(request);
    let models = this.#routingPolicy.select({
      complexity: 1,
      reason: "turn",
      ...(session.models === undefined ? {} : { previous: session.models }),
    });
    await this.#store.update(session.id, { models });
    emit({ type: "session.started", sessionId: session.id, models });

    let sessionEnded = false;
    try {
      await this.#hooks?.run("sessionStart", {
        prompt: request.prompt,
        sessionId: session.id,
      });
      const signal = budget.signal(request.signal);
      const plan = await budget.track(
        this.#runner.plan({
          context: session.contexts.main,
          model: models.main,
          prompt: request.prompt,
          ...(request.reasoning === undefined
            ? {}
            : { reasoning: request.reasoning }),
          ...(signal === undefined ? {} : { signal }),
          ...(request.workerProfiles === undefined
            ? {}
            : { workerProfiles: request.workerProfiles }),
        }),
      );
      emit({ type: "plan.completed", sessionId: session.id, plan });

      const assignments =
        plan.sidekickAssignments ??
        plan.sidekickTasks.map((task) => ({ task }));
      const maxTurns = request.budget?.maxTurns;
      const allowedSidekickTurns =
        maxTurns === undefined ? assignments.length : Math.max(0, maxTurns - 1);
      const sidekickAssignments = assignments.slice(0, allowedSidekickTurns);
      const skippedTurns = assignments.length - sidekickAssignments.length;

      const mainPromise = this.#executeTask(
        session,
        "main",
        plan.mainTask,
        models.main,
        signal,
        emit,
        budget,
        undefined,
        request.reasoning,
        undefined,
      );
      const warnings: string[] =
        skippedTurns === 0
          ? []
          : [
              `Skipped ${String(skippedTurns)} sidekick ${skippedTurns === 1 ? "task" : "tasks"} because the max-turns budget is ${String(maxTurns)}`,
            ];
      const budgetWarningCount = warnings.length;
      const sidekickPromise = this.#executeSidekickTasks(
        session,
        sidekickAssignments,
        models.sidekick,
        signal,
        emit,
        warnings,
        budget,
        request.workerProfiles ?? [],
        request.reasoning,
      );
      const [mainResult, sidekickResults] = await Promise.all([
        mainPromise,
        sidekickPromise,
      ]);

      const synthesis = await budget.track(
        this.#runner.synthesize({
          context: (await this.#store.get(session.id))?.contexts.main ?? [],
          mainResult,
          model: models.main,
          onToolEvent: (event) =>
            emitToolEvent(
              event,
              session.id,
              "main",
              "Synthesize results",
              emit,
              undefined,
            ),
          onStreamPart: (part) =>
            emit({
              type:
                part.type === "reasoning-delta"
                  ? "session.reasoning.delta"
                  : "session.output.delta",
              sessionId: session.id,
              delta: part.text,
            }),
          prompt: request.prompt,
          sessionId: session.id,
          ...(request.reasoning === undefined
            ? {}
            : { reasoning: request.reasoning }),
          sidekickResults,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      budget.consume(synthesis.usage);
      await this.#store.append(session.id, "main", {
        role: "assistant",
        content: synthesis.text,
      });
      const usage = sumUsage([
        mainResult.usage,
        ...sidekickResults.map((result) => result.usage),
        synthesis.usage,
      ]);

      const latest = (await this.#store.get(session.id)) as SessionRecord;
      if (this.#needsCompaction(latest)) {
        await this.#compact(
          latest,
          models,
          signal,
          emit,
          budget,
          request.reasoning,
        );
        models = this.#routingPolicy.select({
          complexity: plan.complexity,
          previous: models,
          reason: "compaction",
          sidekickFailures:
            latest.sidekickFailures + warnings.length - budgetWarningCount,
        });
        await this.#store.update(session.id, {
          models,
          sidekickFailures:
            latest.sidekickFailures + warnings.length - budgetWarningCount,
        });
      }

      sessionEnded = true;
      await this.#hooks?.run("sessionEnd", {
        prompt: request.prompt,
        sessionId: session.id,
      });
      emit({
        type: "session.completed",
        sessionId: session.id,
        text: synthesis.text,
        usage,
      });
      return {
        models,
        sessionId: session.id,
        text: synthesis.text,
        usage,
        warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!sessionEnded) {
        sessionEnded = true;
        try {
          await this.#hooks?.run("sessionEnd", {
            error: message,
            prompt: request.prompt,
            sessionId: session.id,
          });
        } catch {
          // Cleanup hooks must not hide the original failure.
        }
      }
      emit({ type: "session.failed", sessionId: session.id, message });
      throw error;
    }
  }

  async #executeSidekickTasks(
    session: SessionRecord,
    assignments: Array<{ profile?: string; task: string }>,
    model: string,
    signal: AbortSignal | undefined,
    emit: EventListener,
    warnings: string[],
    budget: RunBudgetGuard,
    workerProfiles: FusionWorkerProfile[],
    reasoning: FusionRunRequest["reasoning"],
  ): Promise<AgentTurn[]> {
    const results: AgentTurn[] = [];
    for (const assignment of assignments) {
      const workerId = `${session.id}:sidekick:${String(++this.#workerSequence)}`;
      const profile = workerProfiles.find(
        (candidate) => candidate.name === assignment.profile,
      );
      try {
        results.push(
          await this.#executeTask(
            session,
            "sidekick",
            assignment.task,
            profile?.model ?? model,
            signal,
            emit,
            budget,
            profile,
            reasoning,
            workerId,
          ),
        );
      } catch (error) {
        if (error instanceof FusionBudgetExceededError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(message);
        emit({
          type: "task.failed",
          sessionId: session.id,
          role: "sidekick",
          task: assignment.task,
          message,
          ...(profile === undefined ? {} : { profile: profile.name }),
          workerId,
        });
      }
    }
    return results;
  }

  async #executeTask(
    session: SessionRecord,
    role: AgentRole,
    task: string,
    model: string,
    signal: AbortSignal | undefined,
    emit: EventListener,
    budget: RunBudgetGuard,
    profile: FusionWorkerProfile | undefined,
    reasoning: FusionRunRequest["reasoning"],
    workerId: string | undefined,
  ): Promise<AgentTurn> {
    emit({
      type: "task.started",
      sessionId: session.id,
      role,
      task,
      model,
      ...(profile === undefined ? {} : { profile: profile.name }),
      ...(workerId === undefined ? {} : { workerId }),
    });
    await this.#store.append(session.id, role, { role: "user", content: task });
    const latest = await this.#store.get(session.id);
    const result = await budget.track(
      this.#runner.execute({
        context: latest?.contexts[role] ?? [],
        ...(profile?.tools === undefined ? {} : { activeTools: profile.tools }),
        ...(profile === undefined
          ? {}
          : { instructions: profile.instructions, profile: profile.name }),
        model,
        onToolEvent: (event) =>
          emitToolEvent(event, session.id, role, task, emit, workerId),
        onStreamPart: (part) =>
          emit({
            type:
              part.type === "reasoning-delta"
                ? "task.reasoning.delta"
                : "task.output.delta",
            sessionId: session.id,
            role,
            task,
            delta: part.text,
            ...(profile === undefined ? {} : { profile: profile.name }),
            ...(workerId === undefined ? {} : { workerId }),
          }),
        role,
        ...(reasoning === undefined ? {} : { reasoning }),
        sessionId: session.id,
        task,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    budget.consume(result.usage);
    await this.#store.append(session.id, role, {
      role: "assistant",
      content: result.text,
    });
    emit({
      type: "task.completed",
      sessionId: session.id,
      role,
      task,
      text: result.text,
      ...(profile === undefined ? {} : { profile: profile.name }),
      ...(workerId === undefined ? {} : { workerId }),
    });
    return profile === undefined
      ? result
      : { ...result, profile: profile.name };
  }

  async #compact(
    session: SessionRecord,
    models: { main: string; sidekick: string },
    signal: AbortSignal | undefined,
    emit: EventListener,
    budget: RunBudgetGuard,
    reasoning: FusionRunRequest["reasoning"],
  ): Promise<void> {
    await Promise.all(
      (["main", "sidekick"] as const).map(async (role) => {
        if (session.contexts[role].length < this.#contextMessageLimit) {
          return;
        }
        const summary = await budget.track(
          this.#runner.compact({
            context: session.contexts[role],
            model: models[role],
            ...(reasoning === undefined ? {} : { reasoning }),
            role,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
        await this.#store.compact(session.id, role, summary);
        emit({ type: "context.compacted", sessionId: session.id, role });
      }),
    );
  }

  #needsCompaction(session: SessionRecord): boolean {
    return Object.values(session.contexts).some(
      (context) => context.length >= this.#contextMessageLimit,
    );
  }

  async #loadSession(request: FusionRunRequest): Promise<SessionRecord> {
    if (request.sessionId === undefined) {
      const session = await this.#store.create({ prompt: request.prompt });
      for (const role of ["main", "sidekick"] as const) {
        for (const message of request.messages ?? []) {
          await this.#store.append(session.id, role, message);
        }
      }
      return (await this.#store.get(session.id)) as SessionRecord;
    }
    const existing = await this.#store.get(request.sessionId);
    if (existing === undefined) {
      throw new Error(`Session ${request.sessionId} was not found`);
    }
    return existing;
  }
}

function emitToolEvent(
  event: ToolActivityEvent,
  sessionId: string,
  role: AgentRole,
  task: string,
  emit: EventListener,
  workerId: string | undefined,
): void {
  const identity = workerId === undefined ? {} : { workerId };
  if (event.type === "started") {
    emit({
      ...event,
      ...identity,
      role,
      sessionId,
      task,
      type: "tool.started",
    });
    return;
  }
  if (event.type === "completed") {
    emit({
      ...event,
      ...identity,
      role,
      sessionId,
      task,
      type: "tool.completed",
    });
    return;
  }
  emit({ ...event, ...identity, role, sessionId, task, type: "tool.failed" });
}

function sumUsage(usages: TokenUsage[]): FusionUsage {
  const usage = usages.reduce(
    (total, item) => ({
      inputTokens: total.inputTokens + item.inputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  close(): void {
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.({ done: true, value: undefined });
    }
  }

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#items.push(item);
    } else {
      waiter({ done: false, value: item });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) {
          return Promise.resolve({ done: false, value: item });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
