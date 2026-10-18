import { describe, expect, test } from "bun:test";
import { selectionPrompt, type SelectionRequestAction } from "../../../src/renderer/src/lib/selectionPrompt";
import { en } from "../../../src/renderer/src/i18n/locales/en";
import { zhCN } from "../../../src/renderer/src/i18n/locales/zh-CN";
import type { TranslateFn } from "../../../src/renderer/src/i18n";

for (const [language, messages] of Object.entries({ en, "zh-CN": zhCN })) {
  const t: TranslateFn = (key, params) => messages[key].replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
  describe(language, () => {
    test("each preset quotes the exact selected passage and requests a new reply", () => {
      const original = "First line.\n第二行 <tag> and `code`.";
      const requests = (["explain", "improve", "shorten", "tone", "grammar"] as SelectionRequestAction[]).map(action => {
        const request = selectionPrompt(`  ${original}\n `, { action }, t);
        expect(Object.keys(request)).toEqual(["text"]);
        expect(request.text).toContain(`<selected_passage>\n${original}\n</selected_passage>`);
        expect(request.text).toContain(t(`selection.request.${action}`));
        expect(request.text).toContain(language === "en" ? "leave previous messages unchanged" : "保留之前的消息");
        return request.text;
      });
      expect(new Set(requests).size).toBe(5);
    });
    test("custom instruction and whitespace validation", () => {
      expect(selectionPrompt(" quoted ", { custom: "  Make it formal  " }, t).text).toContain("Make it formal");
      expect(() => selectionPrompt(" \n\t", { action: "explain" }, t)).toThrow();
      expect(() => selectionPrompt("text", { custom: " \n" }, t)).toThrow();
    });
  });
}
