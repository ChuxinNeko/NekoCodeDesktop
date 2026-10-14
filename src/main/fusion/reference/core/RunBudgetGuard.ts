import type { FusionRunBudget, TokenUsage } from "./types.js";

export type FusionBudgetKind = "tokens" | "wall-time";

export class FusionBudgetExceededError extends Error {
  readonly kind: FusionBudgetKind;

  constructor(kind: FusionBudgetKind, message: string) {
    super(message);
    this.name = "FusionBudgetExceededError";
    this.kind = kind;
  }
}

export class RunBudgetGuard {
  readonly #budget: FusionRunBudget;
  readonly #controller = new AbortController();
  readonly #timeoutRejection: Promise<never> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tokens = 0;

  constructor(budget: FusionRunBudget = {}) {
    validateBudget(budget);
    this.#budget = { ...budget };
    if (budget.timeoutMs !== undefined) {
      this.#timeoutRejection = new Promise((_, reject) => {
        this.#timer = setTimeout(() => {
          const error = new FusionBudgetExceededError(
            "wall-time",
            `Wall-time budget exceeded after ${String(budget.timeoutMs)}ms`,
          );
          this.#controller.abort(error);
          reject(error);
        }, budget.timeoutMs);
      });
      void this.#timeoutRejection.catch(() => undefined);
    }
  }

  close(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
  }

  consume(usage: TokenUsage): void {
    this.#tokens += usage.inputTokens + usage.outputTokens;
    if (
      this.#budget.maxTokens !== undefined &&
      this.#tokens > this.#budget.maxTokens
    ) {
      const error = new FusionBudgetExceededError(
        "tokens",
        `Token budget exceeded: observed ${String(this.#tokens)} tokens with a limit of ${String(this.#budget.maxTokens)}`,
      );
      this.#controller.abort(error);
      throw error;
    }
  }

  signal(external: AbortSignal | undefined): AbortSignal | undefined {
    if (external === undefined) {
      return this.#controller.signal;
    }
    return AbortSignal.any([external, this.#controller.signal]);
  }

  async track<T>(operation: Promise<T>): Promise<T> {
    if (this.#timeoutRejection === undefined) {
      return operation;
    }
    return Promise.race([operation, this.#timeoutRejection]);
  }
}

function validateBudget(budget: FusionRunBudget): void {
  validatePositiveInteger(budget.maxTurns, "maxTurns");
  validatePositiveInteger(budget.maxTokens, "maxTokens");
  validatePositiveInteger(budget.timeoutMs, "timeoutMs");
}

function validatePositiveInteger(
  value: number | undefined,
  name: keyof FusionRunBudget,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer`);
  }
}
