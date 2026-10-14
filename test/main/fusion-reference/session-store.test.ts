import { describe, expect, it } from "bun:test";

import { InMemorySessionStore } from "../../../src/main/fusion/reference/sessions/session-store.js";

describe("InMemorySessionStore", () => {
  it("keeps main and sidekick contexts independent", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ prompt: "Ship the feature" });

    await store.append(session.id, "main", {
      role: "assistant",
      content: "plan",
    });
    await store.append(session.id, "sidekick", {
      role: "assistant",
      content: "mechanical change",
    });

    const saved = await store.get(session.id);
    expect(saved?.contexts.main).toHaveLength(1);
    expect(saved?.contexts.sidekick).toHaveLength(1);
    expect(saved?.contexts.main[0]?.content).not.toBe(
      saved?.contexts.sidekick[0]?.content,
    );
  });

  it("compacts one lane without mutating the other", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ prompt: "Refactor" });
    await store.append(session.id, "main", { role: "user", content: "a" });
    await store.append(session.id, "sidekick", { role: "user", content: "b" });

    await store.compact(session.id, "main", "summary");

    const saved = await store.get(session.id);
    expect(saved?.contexts.main).toEqual([
      { role: "system", content: "Compacted context: summary" },
    ]);
    expect(saved?.contexts.sidekick[0]?.content).toBe("b");
    expect(saved?.compactions.main).toBe(1);
  });

  it("returns defensive copies", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ prompt: "Test" });
    const loaded = await store.get(session.id);
    loaded?.contexts.main.push({ role: "user", content: "mutation" });

    expect((await store.get(session.id))?.contexts.main).toHaveLength(0);
  });
});
