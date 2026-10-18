import { describe, expect, test } from "bun:test";
import type { ModelCallRuntime } from "../../src/main/model-call";
import { SelectionExplanationService } from "../../src/main/selection-explanation";
import type { ExplainSelectionRequest } from "../../src/shared/selection-explanation";

function setup(answer = "真实模型返回的解释", getMainContext?: (sessionId?: string) => Promise<unknown>) {
  const calls: { systemPrompt: string; messages: { content: string }[] }[] = [];
  const runtime = {
    getModel: (provider: string, id: string) => provider === "p" && id === "model" ? { provider, id, maxTokens: 8192 } : undefined,
    getAvailable: async () => [],
    completeSimple: async (_model: unknown, context: typeof calls[number]) => {
      calls.push(context);
      return { content: [{ type: "text", text: answer }], stopReason: "stop" };
    },
  } as unknown as ModelCallRuntime;
  return { service: new SelectionExplanationService(async () => runtime, getMainContext), calls };
}
const request: ExplainSelectionRequest = { id: "one", modelKey: "p/model", original: "Selected AI passage", language: "zh-CN", turns: [{ role: "user", text: "请解释这段话。" }] };

describe("isolated explanation service", () => {
  test("reads the requested main conversation again for follow-ups", async () => {
    const sessionIds: (string | undefined)[] = [];
    const mainContext = { cwd: "/project", systemPrompt: "Project instructions", messages: [{ role: "user", content: "Build a search tool" }, { role: "toolResult", content: "Source code" }] };
    const { service, calls } = setup("**Explanation**", async sessionId => { sessionIds.push(sessionId); return mainContext; });
    await service.explain(1, { ...request, sessionId: "main-session" });
    expect(JSON.parse(calls[0].messages[0].content).mainContext).toEqual(mainContext);
    expect(calls[0].systemPrompt).toContain("Markdown");
    mainContext.messages.push({ role: "assistant", content: "New main answer" });
    await service.explain(1, { ...request, id: "followup", sessionId: "main-session" });
    expect(JSON.parse(calls[1].messages[0].content).mainContext.messages.at(-1).content).toBe("New main answer");
    expect(sessionIds).toEqual(["main-session", "main-session"]);
  });

  test("calls the model directly with selected text and only popup history", async () => {
    const { service, calls } = setup();
    expect(await service.explain(1, request)).toEqual({ text: "真实模型返回的解释" });
    expect(JSON.parse(calls[0].messages[0].content)).toEqual({ selectedPassage: request.original, conversation: request.turns });
    expect(calls[0].systemPrompt).toContain("Simplified Chinese");
    const followup: ExplainSelectionRequest = { ...request, id: "two", turns: [...request.turns, { role: "assistant", text: "真实模型返回的解释" }, { role: "user", text: "举个例子？" }] };
    await service.explain(1, followup);
    expect(JSON.parse(calls[1].messages[0].content).conversation).toEqual(followup.turns);
    expect(calls).toHaveLength(2);
    // Service dependencies expose only completeSimple, never session.send/prompt.
  });

  test("rejects empty answers and malformed history without synthesizing a reply", async () => {
    const { service, calls } = setup("  ");
    await expect(service.explain(1, request)).rejects.toThrow("empty explanation");
    await expect(service.explain(1, { ...request, turns: [{ role: "assistant", text: "bad" }] })).rejects.toThrow("Invalid explanation");
    expect(calls).toHaveLength(1);
  });

  test("cancellation belongs to the requesting window", async () => {
    let resolve!: (runtime: ModelCallRuntime) => void;
    const service = new SelectionExplanationService(() => new Promise(done => { resolve = done; }));
    const pending = service.explain(1, request);
    service.cancel(2, request.id);
    service.cancel(1, request.id);
    resolve({} as ModelCallRuntime);
    await expect(pending).rejects.toThrow("cancelled");
  });
});
