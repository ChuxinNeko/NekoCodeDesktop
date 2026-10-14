import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { FileSessionStore } from "../../../src/main/fusion/reference/sessions/file-session-store.js";

describe("FileSessionStore", () => {
  it("persists lane contexts and metadata across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-agent-sessions-"));
    const first = new FileSessionStore({
      directory,
      idFactory: () => "session-1",
      now: () => "2026-07-16T12:00:00.000Z",
    });
    const session = await first.create({ prompt: "ship it" });
    await first.append(session.id, "main", {
      role: "assistant",
      content: "working",
    });
    await first.update(session.id, {
      models: { main: "model-a", sidekick: "model-b" },
    });

    const second = new FileSessionStore({ directory });
    expect(await second.get("session-1")).toMatchObject({
      contexts: { main: [{ content: "working", role: "assistant" }] },
      models: { main: "model-a", sidekick: "model-b" },
      prompt: "ship it",
    });
  });

  it("serializes concurrent mutations without dropping messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-agent-sessions-"));
    const store = new FileSessionStore({
      directory,
      idFactory: () => "session-2",
    });
    const session = await store.create({ prompt: "parallel" });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append(session.id, "sidekick", {
          role: "assistant",
          content: String(index),
        }),
      ),
    );

    expect((await store.get(session.id))?.contexts.sidekick).toHaveLength(20);
  });

  it("lists, forks, and deletes sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-agent-sessions-"));
    const ids = ["source", "forked"];
    const store = new FileSessionStore({
      directory,
      idFactory: () => ids.shift() as string,
    });
    const source = await store.create({ prompt: "source prompt" });
    await store.append(source.id, "main", { role: "user", content: "turn" });

    const forked = await store.fork(source.id);
    expect(forked).toMatchObject({ id: "forked", prompt: "source prompt" });
    expect(forked.contexts.main).toEqual([{ role: "user", content: "turn" }]);
    expect(await store.list()).toHaveLength(2);

    await store.delete(source.id);
    expect(await store.get(source.id)).toBeUndefined();
  });

  it("rejects invalid or corrupt session files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-agent-sessions-"));
    const store = new FileSessionStore({ directory });
    await writeFile(join(directory, "broken.json"), "not-json", "utf8");

    await expect(store.get("../escape")).rejects.toThrow(/invalid session id/i);
    await expect(store.get("broken")).rejects.toThrow(/could not be read/i);
    expect(await readFile(join(directory, "broken.json"), "utf8")).toBe(
      "not-json",
    );
  });
});
