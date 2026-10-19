import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { EditedFileRow } from "../../../../src/renderer/src/components/chat/EditedFileRow";
import CodeBlock from "../../../../src/renderer/src/components/CodeBlock";
import { codeBlockDiff } from "../../../../src/renderer/src/lib/codeBlockDiff";

test("completed filename rows are focusable preview targets without mounting hidden diffs", () => {
	const html = renderToString(<I18nProvider><EditedFileRow checkpointId="turn"
		file={{ path: "src/example.ts", additions: 2, deletions: 1 }} onOpenDiff={() => {}} /></I18nProvider>);
	expect(html).toContain('data-slot="edited-file-row"');
	expect(html).toContain('aria-expanded="false"');
	expect(html).toContain("src/example.ts");
	expect(html).not.toContain('data-slot="edited-file-preview"');
});

test("Beautiful UI CodeBlock renders real checkpoint rows with its original diff appearance", () => {
	const patch = "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -7 +7 @@\n-oldValue\n+newValue\n";
	const html = renderToString(<CodeBlock variant="Diff" filename="src/example.ts" diff={codeBlockDiff(patch)} code={patch} />);
	const text = html.replace(/<[^>]*>/g, "");
	expect(text).toContain("oldValue");
	expect(text).toContain("newValue");
	expect(html).toContain(">7</span>");
	expect(html).toContain("bg-bui-green-tint");
	expect(html).toContain("bg-bui-red-tint");
	expect(html).toContain("shadow-bui-card");
	expect(html).not.toContain("aria-pressed");
});
