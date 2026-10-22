import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { UsageDetails, UsageModelsContext } from "../../../../src/renderer/src/components/chat/UsagePanel";
import type { ModelOption, TurnUsage } from "../../../../src/shared/agent";

const provider = "nekocode-c15d4755-e187-4d06-9427-673dfb54dbbc";
const models: ModelOption[] = [{ provider, providerName: "DeepSeek API", id: "deepseek-v4.1-flash",
	key: `${provider}/deepseek-v4.1-flash`, name: "deepseek-v4.1-flash" }];
const primary: TurnUsage = { provider, model: "deepseek-v4.1-flash", calls: 1, input: 1, output: 1,
	cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
const render = (usage: TurnUsage, options = models) => renderToString(
	<I18nProvider><UsageModelsContext.Provider value={options}><UsageDetails usage={usage} /></UsageModelsContext.Provider></I18nProvider>,
).replaceAll("<!-- -->", "");

describe("turn usage model labels", () => {
	test("shows Claude generation speed when ACP provides SDK API time", () => {
		const html = render({ ...primary, provider: "Claude Agent", model: "deepseek-reasoner", output: 100, totalTokens: 101, durationMs: 120_000, modelMs: 2000 });
		expect(html).toContain("50.0 t/s");
		expect(html).toContain("Claude Agent/deepseek-reasoner");
	});

	test("SideKick keeps its actual model label when detailed records also contain Lead calls", () => {
		const html = render({ ...primary, fusion: { lead: primary, sidekick: { provider, model: "tr-alpha-channel", usage: { ...primary, model: "tr-alpha-channel", totalTokens: 300 } },
			breakdown: [{ source: "main", kind: "inference", usage: primary }, { source: "main", kind: "inference", usage: { ...primary, model: "tr-alpha-channel" } }],
		} });
		expect(html).toContain("DeepSeek API/tr-alpha-channel");
		expect(html).not.toContain("多个实际执行模型");
		expect(html).not.toContain("本轮未记录该模型的用量");
	});
	test("explains ambiguous usage and that code-search totals overlap model totals", () => {
		const html = render({ ...primary, fusion: { lead: { ...primary, calls: 0 }, sidekick: { provider, model: "side" },
			attributionAmbiguous: true, unattributed: primary }, fastContext: { primary, search: { provider, model: "side", usage: primary } } });
		expect(html).toContain("部分用量无法区分");
		expect(html).toContain("其他或未归属模型用量");
		expect(html).toContain("请勿再次相加");
	});
	test("displays the configured provider name instead of its internal ID", () => {
		const html = render(primary);
		expect(html).toContain("DeepSeek API/deepseek-v4.1-flash");
		expect(html).not.toContain(provider);
	});

	test("resolves the provider for historical models and preserves full model IDs", () => {
		expect(render({ ...primary, model: "channel/old-model" })).toContain("DeepSeek API/channel/old-model");
		expect(render({ ...primary, provider: "anthropic" })).toContain("anthropic/deepseek-v4.1-flash");
		expect(render(primary, [])).toContain(`${provider}/deepseek-v4.1-flash`);
	});

	test("uses provider names throughout Fusion and Fast Context usage", () => {
		const html = render({ ...primary, fusion: { lead: primary,
			sidekick: { provider, model: "sidekick", usage: primary },
			breakdown: [{ kind: "inference", usage: { ...primary, model: "sidekick", responseModel: "served-sidekick" } }],
		}, fastContext: { primary, search: { provider, model: "search" } } });
		expect(html).toContain("DeepSeek API/deepseek-v4.1-flash");
		expect(html).toContain("DeepSeek API/sidekick");
		expect(html).toContain("DeepSeek API/served-sidekick");
		expect(html).toContain("DeepSeek API/search");
		expect(html).not.toContain(provider);
	});
});
