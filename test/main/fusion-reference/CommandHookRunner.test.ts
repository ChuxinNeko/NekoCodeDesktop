import { describe, expect, it, vi } from "bun:test";

import { CommandHookRunner } from "../../../src/main/fusion/reference/hooks/CommandHookRunner.js";

describe("CommandHookRunner", () => {
  it("runs matching hooks in declaration order with structured context", async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0 });
    const runner = new CommandHookRunner({
      definitions: [
        {
          command: "first",
          event: "preTool",
          matcher: "^(writeFile|editFile)$",
        },
        { command: "ignored", event: "preTool", matcher: "^readFile$" },
        { command: "second", event: "preTool" },
      ],
      execute,
    });

    await runner.run("preTool", {
      input: { path: "src/index.ts" },
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "writeFile",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      "first",
      "second",
    ]);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "first",
      expect.objectContaining({
        event: "preTool",
        sessionId: "session-1",
        toolName: "writeFile",
      }),
      10_000,
    );
  });

  it("stops the lifecycle when a hook command fails", async () => {
    const runner = new CommandHookRunner({
      definitions: [{ command: "reject", event: "sessionStart" }],
      execute: vi.fn().mockResolvedValue({ exitCode: 7, stderr: "nope" }),
    });

    await expect(
      runner.run("sessionStart", { sessionId: "session-1" }),
    ).rejects.toThrow(/reject.*exit code 7.*nope/i);
  });

  it("rejects invalid matcher expressions at configuration time", () => {
    expect(
      () =>
        new CommandHookRunner({
          definitions: [{ command: "bad", event: "preTool", matcher: "[" }],
          execute: vi.fn(),
        }),
    ).toThrow(/invalid hook matcher/i);
  });
});
