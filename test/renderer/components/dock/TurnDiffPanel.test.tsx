import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { TurnDiffPanel } from "../../../../src/renderer/src/components/dock/TurnDiffPanel";
import type { CheckpointSummary } from "../../../../src/shared/checkpoints";

const checkpoint = { id: "turn", files: [{ path: "first.ts", additions: 1, deletions: 0 }, { path: "src/selected.ts", additions: 3, deletions: 2 }] } as CheckpointSummary;

test("dock diff selects the clicked file and exposes unified/split controls without Git whitespace controls", () => {
  const html = renderToStaticMarkup(<I18nProvider><TurnDiffPanel request={{ checkpoint, path: "src/selected.ts", nonce: 1 }} /></I18nProvider>);
  expect(html).toContain('<option value="src/selected.ts" selected=""');
  expect(html).toContain("2 个文件已更改");
  expect(html).toContain("选择要查看差异的文件");
  expect(html).toContain("统一");
  expect(html).toContain("并排");
  expect(html).not.toContain("¶");
});

test("a retired diff request renders an empty state without retaining a previous file", () => {
  const html = renderToStaticMarkup(<I18nProvider><TurnDiffPanel request={null} /></I18nProvider>);
  expect(html).not.toContain("selected.ts");
  expect(html).not.toContain("<option");
  expect(html).toContain("0 个文件已更改");
});
