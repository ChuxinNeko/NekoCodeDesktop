export interface ModelSelection {
  main: string;
  sidekick: string;
}

export interface RoutingInput {
  complexity: number;
  previous?: ModelSelection;
  reason: "compaction" | "turn";
  sidekickFailures?: number;
}

export interface RoutingPolicy {
  select(input: RoutingInput): ModelSelection;
}

interface AdaptiveRoutingOptions {
  main: string[];
  sidekick: string[];
}

export class AdaptiveRoutingPolicy implements RoutingPolicy {
  readonly #main: string[];
  readonly #sidekick: string[];

  constructor(options: AdaptiveRoutingOptions) {
    if (options.main.length === 0 || options.sidekick.length === 0) {
      throw new Error("At least one main and sidekick model are required");
    }
    this.#main = [...options.main];
    this.#sidekick = [...options.sidekick];
  }

  select(input: RoutingInput): ModelSelection {
    const initial = {
      main: this.#main[0] as string,
      sidekick: this.#sidekick[0] as string,
    };
    if (input.reason === "turn") {
      return input.previous ?? initial;
    }

    const previous = input.previous ?? initial;
    const main =
      input.complexity < 0.85
        ? (this.#main[1] ?? previous.main)
        : previous.main;
    const failures = input.sidekickFailures ?? 0;
    const sidekickIndex = Math.min(
      failures > 0 ? 1 : 0,
      this.#sidekick.length - 1,
    );
    return {
      main,
      sidekick: this.#sidekick[sidekickIndex] ?? previous.sidekick,
    };
  }
}
