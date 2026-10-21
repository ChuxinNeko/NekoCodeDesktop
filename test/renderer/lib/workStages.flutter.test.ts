import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { WorkItem } from "../../../src/shared/transcript";
import { groupWorkStages, workStageCompleted, workStageLabel } from "../../../src/renderer/src/lib/workStages";
import { zhCN } from "../../../src/renderer/src/i18n/locales/zh-CN";
import type { TranslateFn } from "../../../src/renderer/src/i18n";
const translate = ((key: keyof typeof zhCN) => zhCN[key]) as TranslateFn;
const fixtures = JSON.parse(readFileSync(new URL("../../../mobile_flutter/test/fixtures/work_stages.json", import.meta.url), "utf8"));
for (const fixture of fixtures) test(`Flutter workflow parity: ${fixture.name}`, () => {
	expect(groupWorkStages(fixture.items as WorkItem[]).map(stage => ({
		id: stage.id, title: workStageLabel(stage, translate), completed: workStageCompleted(stage),
		items: stage.items.map(item => ({ kind: item.kind, id: item.id, text: item.kind === "thinking" ? item.cell.thinking : item.kind === "tool" ? "" : item.cell.text })),
	}))).toEqual(fixture.expected);
});
