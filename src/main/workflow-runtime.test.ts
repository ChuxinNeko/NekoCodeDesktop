import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { selectFastContextModel } from "./workflow-runtime";
import type { resolveFusion } from "./fusion-config";

const model = (provider: string, id: string) => ({ provider, id }) as Model<Api>;
const parent = model("anthropic", "lead");
const sidekick = model("zai", "side");
const dedicated = model("openai", "scan");
const available = [parent, sidekick, dedicated];
const fusion = {
	config: {
		leadModelKey: "anthropic/lead", leadThinkingLevel: "high",
		sidekickModelKey: "zai/side", sidekickThinkingLevel: "medium",
	},
	lead: parent, sidekick,
} as Awaited<ReturnType<typeof resolveFusion>>;

describe("selectFastContextModel", () => {
	test("prefers the dedicated model", () => {
		const pick = selectFastContextModel(
			{ modelKey: "openai/scan", thinkingLevel: "high" }, available, parent, fusion,
		);
		expect(pick.model).toBe(dedicated);
		expect(pick.requestedThinkingLevel).toBe("high");
	});
	test("falls back to the Fusion Sidekick", () => {
		const pick = selectFastContextModel(
			{ modelKey: null, thinkingLevel: "low" }, available, parent, fusion,
		);
		expect(pick.model).toBe(sidekick);
		expect(pick.requestedThinkingLevel).toBe("medium");
	});
	test("falls back to the parent model", () => {
		const pick = selectFastContextModel(
			{ modelKey: null, thinkingLevel: "low" }, available, parent, null,
		);
		expect(pick.model).toBe(parent);
		expect(pick.requestedThinkingLevel).toBe("low");
	});
	test("a stale dedicated key falls through to Fusion, then parent", () => {
		const config = { modelKey: "gone/missing", thinkingLevel: "high" } as const;
		expect(selectFastContextModel(config, available, parent, fusion).model).toBe(sidekick);
		expect(selectFastContextModel(config, available, parent, null).model).toBe(parent);
	});
});
