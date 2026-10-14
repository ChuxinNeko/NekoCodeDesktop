import { describe, expect, it, vi } from "bun:test";

import { FusionEngine } from "../../../src/main/fusion/reference/core/fusion-engine.js";
import { InMemorySessionStore } from "../../../src/main/fusion/reference/sessions/session-store.js";
import type {
  AgentRunner,
  FusionEvent,
  FusionPlan,
  PlanRequest,
} from "../../../src/main/fusion/reference/core/types.js";

function createRunner(): AgentRunner {
  return {
    plan: vi.fn().mockResolvedValue({
      complexity: 0.7,
      mainTask: "Design and integrate",
      sidekickTasks: ["Inspect tests", "Apply mechanical edits"],
    }),
    execute: vi.fn(async ({ role, task }) => ({
      text: `${role}:${task}`,
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    synthesize: vi.fn().mockResolvedValue({
      text: "authoritative result",
      usage: { inputTokens: 8, outputTokens: 3 },
    }),
    compact: vi.fn().mockResolvedValue("compact summary"),
  };
}

describe("FusionEngine", () => {
  it("seeds a fresh session with ephemeral conversation messages", async () => {
    const runner = createRunner();
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });
    const messages = [
      { role: "user" as const, content: "First question" },
      { role: "assistant" as const, content: "First answer" },
    ];

    await engine.run({ messages, prompt: "Follow up" });

    expect(runner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ context: messages, prompt: "Follow up" }),
    );
    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.arrayContaining(messages),
      }),
    );
  });

  it("runs session lifecycle hooks around the coordinated run", async () => {
    const order: string[] = [];
    const runner = createRunner();
    runner.plan = vi.fn(async () => {
      order.push("plan");
      return { complexity: 0.5, mainTask: "main", sidekickTasks: [] };
    });
    const hooks = {
      run: vi.fn(async (event: string) => {
        order.push(event);
      }),
    };
    const engine = new FusionEngine({
      hooks,
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    await engine.run({ prompt: "hook it" });

    expect(order[0]).toBe("sessionStart");
    expect(order.at(-1)).toBe("sessionEnd");
    expect(hooks.run).toHaveBeenLastCalledWith(
      "sessionEnd",
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });

  it("blocks model execution when a session-start hook fails and still runs session-end", async () => {
    const runner = createRunner();
    const hooks = {
      run: vi.fn(async (event: string) => {
        if (event === "sessionStart") {
          throw new Error("hook rejected");
        }
      }),
    };
    const engine = new FusionEngine({
      hooks,
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    await expect(engine.run({ prompt: "blocked" })).rejects.toThrow(
      "hook rejected",
    );
    expect(runner.plan).not.toHaveBeenCalled();
    expect(hooks.run).toHaveBeenLastCalledWith(
      "sessionEnd",
      expect.objectContaining({ error: "hook rejected" }),
    );
  });

  it("rejects invalid run budgets before calling a model", async () => {
    const runner = createRunner();
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    await expect(
      engine.run({ prompt: "bounded", budget: { maxTurns: 0 } }),
    ).rejects.toThrow(/maxTurns must be a positive integer/i);
    expect(runner.plan).not.toHaveBeenCalled();
  });

  it("limits planned agent task turns while preserving main synthesis", async () => {
    const runner = createRunner();
    const store = new InMemorySessionStore();
    const engine = new FusionEngine({
      contextMessageLimit: 2,
      runner,
      store,
      models: { main: ["m"], sidekick: ["s"] },
    });

    const result = await engine.run({
      prompt: "bounded",
      budget: { maxTurns: 2 },
    });

    expect(runner.execute).toHaveBeenCalledTimes(2);
    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({ role: "main" }),
    );
    expect(runner.synthesize).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain(
      "Skipped 1 sidekick task because the max-turns budget is 2",
    );
    expect((await store.get(result.sessionId))?.sidekickFailures).toBe(0);
  });

  it("fails before synthesis when observed token usage exceeds the budget", async () => {
    const runner = createRunner();
    runner.plan = vi.fn().mockResolvedValue({
      complexity: 0.5,
      mainTask: "main",
      sidekickTasks: [],
    });
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    await expect(
      engine.run({ prompt: "bounded", budget: { maxTokens: 10 } }),
    ).rejects.toThrow(/token budget exceeded.*15.*10/i);
    expect(runner.synthesize).not.toHaveBeenCalled();
  });

  it("aborts an in-flight model call when wall-time expires", async () => {
    const runner = createRunner();
    runner.plan = vi.fn(
      ({ signal }: PlanRequest): Promise<FusionPlan> =>
        new Promise<FusionPlan>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    await expect(
      engine.run({ prompt: "bounded", budget: { timeoutMs: 10 } }),
    ).rejects.toThrow(/wall-time budget exceeded.*10ms/i);
  });

  it("lets the main agent plan, runs both lanes, and returns main synthesis", async () => {
    const runner = createRunner();
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["frontier/main"], sidekick: ["fast/sidekick"] },
    });

    const result = await engine.run({ prompt: "Implement the issue" });

    expect(runner.plan).toHaveBeenCalledTimes(1);
    expect(runner.execute).toHaveBeenCalledTimes(3);
    expect(runner.synthesize).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("authoritative result");
    expect(result.models).toEqual({
      main: "frontier/main",
      sidekick: "fast/sidekick",
    });
    expect(result.usage.totalTokens).toBe(56);
  });

  it("propagates the selected reasoning effort through every model phase", async () => {
    const runner = createRunner();
    const engine = new FusionEngine({
      contextMessageLimit: 2,
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    await engine.run({ prompt: "think carefully", reasoning: "high" });

    expect(runner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: "high" }),
    );
    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: "high" }),
    );
    expect(runner.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: "high" }),
    );
    expect(runner.compact).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: "high" }),
    );
  });

  it("executes planner-assigned sidekick profiles with scoped model and tools", async () => {
    const runner = createRunner();
    runner.plan = vi.fn().mockResolvedValue({
      complexity: 0.5,
      mainTask: "integrate",
      sidekickAssignments: [{ profile: "reviewer", task: "inspect the diff" }],
      sidekickTasks: ["inspect the diff"],
    });
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["main"], sidekick: ["sidekick"] },
    });
    const workerProfiles = [
      {
        instructions: "Review only. Do not edit.",
        model: "review/model",
        name: "reviewer",
        tools: ["readFile", "searchFiles"],
      },
    ];

    await engine.run({
      prompt: "review and integrate",
      workerProfiles,
    });

    expect(runner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ workerProfiles }),
    );
    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["readFile", "searchFiles"],
        instructions: "Review only. Do not edit.",
        model: "review/model",
        profile: "reviewer",
        role: "sidekick",
      }),
    );
  });

  it("assigns every sidekick a stable worker id that is fresh for each run", async () => {
    const runner = createRunner();
    runner.plan = vi.fn().mockResolvedValue({
      complexity: 0.5,
      mainTask: "integrate",
      sidekickTasks: ["inspect", "test"],
    });
    runner.execute = vi.fn(async (request) => {
      request.onStreamPart?.({ type: "reasoning-delta", text: "thinking" });
      request.onStreamPart?.({ type: "text-delta", text: "working" });
      request.onToolEvent?.({
        input: {},
        toolCallId: `tool-${request.task}`,
        toolName: "listFiles",
        type: "started",
      });
      return {
        text: `done:${request.task}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    const collectIds = async (prompt: string) => {
      const events: FusionEvent[] = [];
      for await (const event of engine.stream({ prompt })) {
        events.push(event);
      }
      const sidekickEvents = events.filter(
        (
          event,
        ): event is FusionEvent & {
          role: "sidekick";
          task: string;
          workerId?: string;
        } => "role" in event && event.role === "sidekick",
      );
      expect(sidekickEvents).not.toHaveLength(0);
      expect(
        sidekickEvents.every((event) => event.workerId !== undefined),
      ).toBe(true);
      const starts = sidekickEvents.filter(
        (event) => event.type === "task.started",
      );
      expect(new Set(starts.map((event) => event.workerId)).size).toBe(2);
      for (const start of starts) {
        expect(
          sidekickEvents
            .filter((event) => "task" in event && event.task === start.task)
            .every((event) => event.workerId === start.workerId),
        ).toBe(true);
      }
      return new Set(starts.map((event) => event.workerId));
    };

    const firstRun = await collectIds("first");
    const secondRun = await collectIds("second");
    expect([...secondRun].every((id) => !firstRun.has(id))).toBe(true);
  });

  it("starts main and sidekick execution concurrently", async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createRunner();
    runner.execute = vi.fn(async ({ role }) => {
      started.push(role);
      if (started.length === 2) {
        release?.();
      }
      await gate;
      return { text: role, usage: { inputTokens: 0, outputTokens: 0 } };
    });
    runner.plan = vi.fn().mockResolvedValue({
      complexity: 0.5,
      mainTask: "main",
      sidekickTasks: ["sidekick"],
    });
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });

    await engine.run({ prompt: "parallel" });

    expect(started).toEqual(expect.arrayContaining(["main", "sidekick"]));
  });

  it("streams lifecycle events in a stable order", async () => {
    const engine = new FusionEngine({
      runner: createRunner(),
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });
    const events: FusionEvent[] = [];

    for await (const event of engine.stream({ prompt: "stream it" })) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("session.started");
    expect(events.some((event) => event.type === "plan.completed")).toBe(true);
    expect(
      events.filter((event) => event.type === "task.completed"),
    ).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("session.completed");
  });

  it("forwards task and final reasoning and output deltas without changing whitespace", async () => {
    const runner = createRunner();
    runner.plan = vi.fn().mockResolvedValue({
      complexity: 0.5,
      mainTask: "main",
      sidekickTasks: [],
    });
    runner.execute = vi.fn(async (request) => {
      request.onStreamPart?.({ type: "reasoning-delta", text: "Inspect" });
      request.onStreamPart?.({ type: "text-delta", text: "task result" });
      return {
        text: "task result",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    runner.synthesize = vi.fn(async (request) => {
      request.onStreamPart?.({ type: "reasoning-delta", text: "Reconcile" });
      request.onStreamPart?.({ type: "text-delta", text: "Hello" });
      request.onStreamPart?.({ type: "text-delta", text: " world" });
      return {
        text: "Hello world",
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    });
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });
    const events: FusionEvent[] = [];

    for await (const event of engine.stream({ prompt: "stream it" })) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task.reasoning.delta",
          role: "main",
          delta: "Inspect",
        }),
        expect.objectContaining({
          type: "task.output.delta",
          role: "main",
          delta: "task result",
        }),
        expect.objectContaining({
          type: "session.reasoning.delta",
          delta: "Reconcile",
        }),
      ]),
    );
    expect(
      events
        .filter((event) => event.type === "session.output.delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("Hello world");
    expect(events.at(-1)).toMatchObject({
      type: "session.completed",
      text: "Hello world",
    });
  });

  it("streams structured tool activity with lane and task context", async () => {
    const runner = createRunner();
    runner.plan = vi.fn().mockResolvedValue({
      complexity: 0.5,
      mainTask: "inspect",
      sidekickTasks: [],
    });
    runner.execute = vi.fn(async (request) => {
      request.onToolEvent?.({
        input: { path: "package.json" },
        toolCallId: "tool-1",
        toolName: "read_file",
        type: "started",
      });
      request.onToolEvent?.({
        durationMs: 3,
        output: { content: "{}" },
        toolCallId: "tool-1",
        toolName: "read_file",
        type: "completed",
      });
      return { text: "inspected", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s"] },
    });
    const events: FusionEvent[] = [];

    for await (const event of engine.stream({ prompt: "inspect" })) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "main",
          task: "inspect",
          toolCallId: "tool-1",
          toolName: "read_file",
          type: "tool.started",
        }),
        expect.objectContaining({
          durationMs: 3,
          role: "main",
          toolCallId: "tool-1",
          type: "tool.completed",
        }),
      ]),
    );
  });

  it("continues with main work when a sidekick task fails", async () => {
    const runner = createRunner();
    runner.execute = vi.fn(async ({ role, task }) => {
      if (role === "sidekick") {
        throw new Error("small model failed");
      }
      return { text: task, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const engine = new FusionEngine({
      runner,
      store: new InMemorySessionStore(),
      models: { main: ["m"], sidekick: ["s", "s2"] },
    });

    const result = await engine.run({ prompt: "resilient" });

    expect(result.text).toBe("authoritative result");
    expect(result.warnings).toHaveLength(2);
  });

  it("compacts and revisits routing only after the configured threshold", async () => {
    const runner = createRunner();
    const store = new InMemorySessionStore();
    const engine = new FusionEngine({
      runner,
      store,
      contextMessageLimit: 2,
      models: { main: ["m1", "m2"], sidekick: ["s1", "s2"] },
    });

    const first = await engine.run({ prompt: "one" });
    const second = await engine.run({
      prompt: "two",
      sessionId: first.sessionId,
    });

    expect(runner.compact).toHaveBeenCalled();
    expect(second.models.main).toBe("m2");
  });
});
