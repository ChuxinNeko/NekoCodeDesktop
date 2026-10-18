import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { dispatchSelectionAction } from "../../../src/renderer/src/lib/selectionPrompt";
import { ExplanationChat, explanationLabels, explanationMessages, type ExplanationChatState } from "../../../src/renderer/src/lib/explanationChat";
import ChatComposer from "../../../src/renderer/src/components/primitives/ChatComposer";
import { en } from "../../../src/renderer/src/i18n/locales/en";
import { zhCN } from "../../../src/renderer/src/i18n/locales/zh-CN";
import type { TranslateFn } from "../../../src/renderer/src/i18n";
import type { ExplainSelectionRequest } from "../../../src/shared/selection-explanation";

for (const [language, messages] of Object.entries({ en, "zh-CN": zhCN })) {
  const t: TranslateFn = (key, params) => messages[key].replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
  describe(language, () => {
    test("Explain and popup follow-ups never call the main-session sender", async () => {
      const main: unknown[] = [];
      const requests: ExplainSelectionRequest[] = [];
      let state: ExplanationChatState = { turns: [], busy: false, error: false };
      let popup: ExplanationChat | undefined;
      const handlers = {
        send: (request: unknown) => { main.push(request); },
        explain: (original: string) => {
          popup = new ExplanationChat({ original, modelKey: "p/model", language: language as "en" | "zh-CN", sessionId: "main-session" }, {
            request: async request => { requests.push(request); return { text: `Answer ${requests.length}` }; },
            cancel: async () => {},
          }, next => { state = next; });
          void popup.send(t("selection.chat.initialPrompt"));
        },
      };
      await dispatchSelectionAction("original words", { action: "explain" }, t, handlers);
      expect(requests).toHaveLength(1);
      expect(state.turns.at(-1)?.text).toBe("Answer 1");
      await popup!.send("Give an example");
      expect(requests).toHaveLength(2);
      expect(requests.map(request => request.sessionId)).toEqual(["main-session", "main-session"]);
      expect(requests[1].turns.map(turn => turn.text)).toEqual([t("selection.chat.initialPrompt"), "Answer 1", "Give an example"]);
      expect(state.turns.at(-1)?.text).toBe("Answer 2");
      expect(main).toEqual([]);
      for (const action of ["improve", "shorten", "tone", "grammar"] as const) await dispatchSelectionAction("original words", { action }, t, handlers);
      // A custom instruction that happens to say "explain" still uses the old path.
      await dispatchSelectionAction("original words", { custom: "explain" }, t, handlers);
      expect(main).toHaveLength(5);
      expect(requests).toHaveLength(2);
    });

    test("official Chat renders all turns and localized input without gallery copy", () => {
      const state: ExplanationChatState = { turns: [{ role: "user", text: t("selection.chat.initialPrompt") }, { role: "assistant", text: "A real answer" }, { role: "user", text: "Follow up" }, { role: "assistant", text: "Another real answer" }], busy: true, error: false };
      const html = renderToStaticMarkup(<ChatComposer messages={explanationMessages(state, t)} labels={explanationLabels(t)} suggestions={[t("selection.chat.context")]} />);
      for (const text of ["A real answer", "Follow up", "Another real answer", t("selection.chat.pending"), t("selection.chat.placeholder"), t("selection.chat.prompt"), t("selection.chat.send")]) expect(html).toContain(text);
      for (const demo of ["mint chip", "Sales History", "Flavor Data", "Trend Detection", "Flavors", "Suppliers"]) expect(html).not.toContain(demo);
      expect(t("selection.chat.source")).toBe(language === "en" ? "Selected passage" : "选中原文");
      expect(t("selection.chat.title")).toBe(language === "en" ? "Explain selection" : "解释选中内容");
    });
  });
}

test("closing cancels the popup request and ignores late results", async () => {
  let resolve!: (value: { text: string }) => void;
  const cancelled: string[] = [];
  const states: ExplanationChatState[] = [];
  const chat = new ExplanationChat({ original: "source", modelKey: "p/m", language: "zh-CN" }, {
    request: () => new Promise(done => { resolve = done; }), cancel: async id => { cancelled.push(id); },
  }, state => states.push(state));
  const pending = chat.send("explain");
  await chat.send("duplicate while busy");
  chat.dispose();
  resolve({ text: "late answer" });
  await pending;
  expect(cancelled).toHaveLength(1);
  expect(states).toHaveLength(1);
  expect(states[0].turns).toHaveLength(1);
});

test("explanation replies render Markdown headings, lists, code and tables", () => {
  const html = renderToStaticMarkup(<ChatComposer messages={[{
    role: "assistant", label: "Assistant", sub: "", time: "",
    body: "## Heading\n\n**Bold**\n\n- Item\n\n```ts\nconst value = 1;\n```\n\n| Key | Value |\n| --- | --- |\n| A | B |",
  }]} labels={{ initialPrompt: "Explain", placeholder: "Ask", prompt: "Question", send: "Send", action: "Action" }} />);
  for (const tag of ["<h2>", "<strong>", "<ul>", "<pre>", '<code class="language-ts">', "<table>"]) expect(html).toContain(tag);
});

test("failed requests can retry without adding another user turn", async () => {
  let state: ExplanationChatState = { turns: [], busy: false, error: false };
  let calls = 0;
  const chat = new ExplanationChat({ original: "source", modelKey: "p/m", language: "en" }, {
    request: async () => { if (++calls === 1) throw new Error("offline"); return { text: "answer" }; }, cancel: async () => {},
  }, next => { state = next; });
  await chat.send("explain");
  expect(state.error).toBe(true);
  expect(state.busy).toBe(false);
  await chat.retry();
  expect(state.turns).toEqual([{ role: "user", text: "explain" }, { role: "assistant", text: "answer" }]);
});
