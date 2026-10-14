import { describe, expect, it } from "bun:test";

import {
  FusionBudgetExceededError,
  RunBudgetGuard,
} from "../../../src/main/fusion/reference/core/RunBudgetGuard.js";

describe("RunBudgetGuard", () => {
  it("validates positive integer limits", () => {
    expect(() => new RunBudgetGuard({ maxTokens: 1.5 })).toThrow(/integer/i);
    expect(() => new RunBudgetGuard({ timeoutMs: -1 })).toThrow(/positive/i);
  });

  it("tracks cumulative observed token usage", () => {
    const budget = new RunBudgetGuard({ maxTokens: 5 });
    const signal = budget.signal(undefined);

    budget.consume({ inputTokens: 2, outputTokens: 1 });
    expect(() => budget.consume({ inputTokens: 2, outputTokens: 1 })).toThrow(
      FusionBudgetExceededError,
    );
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(FusionBudgetExceededError);
    budget.close();
  });

  it("combines caller cancellation with the deadline signal", () => {
    const caller = new AbortController();
    const budget = new RunBudgetGuard();
    const signal = budget.signal(caller.signal);

    caller.abort("cancelled");

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("cancelled");
    budget.close();
  });
});
