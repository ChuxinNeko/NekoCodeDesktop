import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelsTab } from "../../../src/renderer/src/components/settings/ModelsTab";
import { I18nProvider } from "../../../src/renderer/src/i18n";
import type { ModelProfileSummary } from "../../../src/shared/settings";

test("model settings show resolved capabilities and distinguish manual, endpoint and catalog sources", () => {
	const profile: ModelProfileSummary = {
		id: "p", kind: "custom-api", name: "Test", baseUrl: "https://example.test", route: "/v1/responses", api: "openai-responses",
		modelIds: ["model"], reasoning: false, imageInput: false, contextWindow: 256000, maxTokens: 32768,
		modelOverrides: {}, modelThinking: { model: ["high"] }, hasApiKey: true, createdAt: 1, updatedAt: 1,
		modelCapabilities: { model: { contextWindow: 128000, maxTokens: 64000, thinkingLevels: ["low", "max"],
			sources: { contextWindow: "endpoint", maxTokens: "catalog", thinkingLevels: "endpoint" }, fetchedAt: 1 } },
	};
	const html = renderToStaticMarkup(<I18nProvider><ModelsTab profiles={[profile]} accounts={[]} selectedId="p" busy={false}
		autoFetchId={null} onSelect={() => {}} onAutoFetchHandled={() => {}} onFetch={async () => []}
		onSaveModels={() => {}} onSaveModelSettings={() => {}} onTest={() => {}} onAddProvider={() => {}} /></I18nProvider>);
	expect(html).toContain("128000");
	expect(html).toContain("64000");
	expect(html).toContain("思考 high");
	expect(html).toContain("来源：上下文 接口 · 输出 内置参考 · 思考 手动");
	expect(html).not.toContain("思考 low / max");
	expect(html).toContain("批量配置");
	expect(html).toContain("全选已启用模型");
	expect(html).toContain("选择模型 model");
});
