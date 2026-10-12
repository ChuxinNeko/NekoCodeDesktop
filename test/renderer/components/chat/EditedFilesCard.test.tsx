import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { EditedFilesCard } from "../../../../src/renderer/src/components/chat/EditedFilesCard";
import type { CheckpointSummary } from "../../../../src/shared/checkpoints";

const checkpoint: CheckpointSummary = { id: "checkpoint", sessionId: "session", createdAt: 1, label: "Edit", cellId: "prompt",
	conversationRestorable: true, codeRestorable: true, fileCount: 1, files: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
	additions: 4, deletions: 2, shellRuns: 0 };
const render = (live: boolean) => renderToString(<I18nProvider><EditedFilesCard checkpoint={checkpoint} live={live}
	onRestore={() => undefined} onOpenFile={() => undefined} onReview={() => undefined} /></I18nProvider>).replaceAll("<!-- -->", "");

test("live file card shows paths, totals, review and collapse without undo", () => {
	const html = render(true);
	expect(html).toContain('data-live="true"');
	expect(html).toContain("src/app.ts");
	expect(html).toContain("+4");
	expect(html).toContain("−2");
	expect(html).toContain('aria-expanded="true"');
	expect(html).toMatch(/审查|Review/);
	expect(html).not.toMatch(/撤销|Undo/);
	expect(html).not.toContain("animate-spin");
});
test("completed file card keeps the file list and offers undo", () => {
	const html = render(false);
	expect(html).not.toContain('data-live="true"');
	expect(html).toContain("src/app.ts");
	expect(html).toMatch(/撤销|Undo/);
});
