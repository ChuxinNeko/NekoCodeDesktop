import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TurnUsage } from "../shared/agent";
import { UsageDetails } from "../renderer/src/components/chat/UsagePanel";
import { I18nProvider } from "../renderer/src/i18n";

const lead: TurnUsage = { provider: "test", model: "lead-model", calls: 2, input: 1000, output: 200, cacheRead: 3000, cacheWrite: 1000, totalTokens: 5200, modelMs: 4000, reasoning: 80 };
const sidekick: TurnUsage = { ...lead, model: "sidekick-model", calls: 3, input: 7000, totalTokens: 11200, modelMs: 10000 };
const fusion: TurnUsage = { ...lead, totalTokens: 16400, fusion: { lead, sidekick: { provider: "test", model: sidekick.model, usage: sidekick } } };
const render = (usage: TurnUsage) => renderToStaticMarkup(<I18nProvider><UsageDetails usage={usage} /></I18nProvider>);

describe("message usage grids", () => {
	test("renders independent Lead and SideKick metrics and their combined tokens", () => {
		const markup = render(fusion);
		expect(markup).toContain("Lead");
		expect(markup).toContain("SideKick");
		expect(markup).toContain("test/lead-model");
		expect(markup).toContain("test/sidekick-model");
		expect(markup).toContain("16,400");
		expect(markup).toContain("50.0 t/s");
		expect(markup).toContain("20.0 t/s");
		expect(markup.match(/<dt /g)).toHaveLength(18);
	});

	test("single-model usage has nine metrics, including cache rate and reasoning", () => {
		const markup = render(lead);
		expect(markup.match(/<dt /g)).toHaveLength(9);
		expect(markup).toContain("60.0%");
		expect(markup).toContain("其中思考 80");
		expect(markup).not.toContain("$0");
	});

	test("missing historical metrics remain unknown", () => {
		const markup = render({ ...fusion, fusion: { lead, sidekick: { provider: "test", model: "sidekick-model" } } });
		expect(markup).toContain("本轮未记录该模型的用量");
		expect(markup).toContain("test/sidekick-model");
		expect(markup).toContain("—");
	});
});
