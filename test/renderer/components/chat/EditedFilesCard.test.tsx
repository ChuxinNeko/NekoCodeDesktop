import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { EditedFilesCard } from "../../../../src/renderer/src/components/chat/EditedFilesCard";
import type { CheckpointSummary } from "../../../../src/shared/checkpoints";

const checkpoint: CheckpointSummary = { id: "checkpoint", sessionId: "session", createdAt: 1, label: "Edit", cellId: "prompt",
	conversationRestorable: true, codeRestorable: true, fileCount: 1, files: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
	additions: 4, deletions: 2, shellRuns: 0 };
const many: CheckpointSummary = {
	...checkpoint,
	fileCount: 4,
	files: [
		{ path: "pool.mjs", additions: 20, deletions: 7 },
		{ path: "server.mjs", additions: 14, deletions: 4 },
		{ path: "test/adapter.test.mjs", additions: 54, deletions: 1 },
		{ path: "hidden.mjs", additions: 1, deletions: 0 },
	],
	additions: 89,
	deletions: 12,
};
const render = (live: boolean, value: CheckpointSummary = checkpoint) => renderToString(<I18nProvider><EditedFilesCard checkpoint={value} live={live}
	onRestore={() => undefined} onOpenFile={() => undefined} onReview={() => undefined} /></I18nProvider>).replaceAll("<!-- -->", "");

test("live file capsule shows the file count and line totals without the file list or undo", () => {
	const html = render(true);
	expect(html).toContain('data-live="true"');
	expect(html).toContain("rounded-full");
	expect(html).toMatch(/已修改 1 个文件|Modified 1 files/);
	expect(html).toContain("+4");
	expect(html).toContain("−2");
	expect(html).not.toContain("src/app.ts");
	expect(html).not.toMatch(/撤销|Undo/);
	expect(html).not.toMatch(/查看变更|View changes/);
});

test("completed file card lists files, undo, and review, and folds the rest", () => {
	const html = render(false, many);
	expect(html).not.toContain('data-live="true"');
	expect(html).toMatch(/已编辑 4 个文件|Edited 4 files/);
	expect(html).toContain("pool.mjs");
	expect(html).toContain("server.mjs");
	expect(html).toContain("test/adapter.test.mjs");
	expect(html).not.toContain("hidden.mjs");
	expect(html).toContain("+20");
	expect(html).toContain("−7");
	expect(html).toMatch(/撤销|Undo/);
	expect(html).toMatch(/查看变更|View changes/);
	expect(html).toMatch(/再显示 1 个文件|Show 1 more files/);
});
