import { describe, expect, it } from "bun:test";

import { AdaptiveRoutingPolicy } from "../../../src/main/fusion/reference/core/routing-policy.js";

describe("AdaptiveRoutingPolicy", () => {
  const policy = new AdaptiveRoutingPolicy({
    main: ["frontier/large", "frontier/medium"],
    sidekick: ["fast/small", "fast/medium", "frontier/medium"],
  });

  it("requires at least one model for each lane", () => {
    expect(
      () => new AdaptiveRoutingPolicy({ main: [], sidekick: ["fast/small"] }),
    ).toThrow(/at least one/i);
    expect(
      () =>
        new AdaptiveRoutingPolicy({ main: ["frontier/large"], sidekick: [] }),
    ).toThrow(/at least one/i);
  });

  it("keeps model selection stable between compactions", () => {
    const selected = policy.select({ complexity: 0.9, reason: "turn" });

    expect(selected).toEqual({
      main: "frontier/large",
      sidekick: "fast/small",
    });
  });

  it("upgrades the sidekick at a compaction boundary after poor results", () => {
    const selected = policy.select({
      complexity: 0.8,
      reason: "compaction",
      previous: { main: "frontier/large", sidekick: "fast/small" },
      sidekickFailures: 2,
    });

    expect(selected.sidekick).toBe("fast/medium");
  });

  it("downgrades the main model only for low-complexity work at compaction", () => {
    const selected = policy.select({
      complexity: 0.1,
      reason: "compaction",
      previous: { main: "frontier/large", sidekick: "fast/small" },
      sidekickFailures: 0,
    });

    expect(selected.main).toBe("frontier/medium");
  });
});
