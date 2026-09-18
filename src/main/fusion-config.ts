import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { isFusionConfig, type FusionConfig } from "../shared/fusion";
import { piAi } from "./pi";

export const FUSION_ENTRY = "nekocode.fusion.v1";

export function savedFusion(manager: Pick<SessionManager, "getBranch">): FusionConfig | null {
	const entries = manager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === FUSION_ENTRY)
			return isFusionConfig(entry.data) ? { ...entry.data } : null;
	}
	return null;
}

export async function resolveFusion(value: unknown, runtime: ModelRuntime) {
	if (!isFusionConfig(value)) throw new Error("Invalid Fusion configuration");
	const available = runtime.getAvailableSnapshot();
	const lead = available.find((m) => `${m.provider}/${m.id}` === value.leadModelKey);
	const sidekick = available.find((m) => `${m.provider}/${m.id}` === value.sidekickModelKey);
	if (!lead) throw new Error("Fusion Lead 模型不可用，请重新选择模型");
	if (!sidekick) throw new Error("Fusion Sidekick 模型不可用，请重新选择模型");
	const { clampThinkingLevel } = await piAi();
	const config: FusionConfig = {
		...value,
		leadThinkingLevel: clampThinkingLevel(lead, value.leadThinkingLevel),
		sidekickThinkingLevel: clampThinkingLevel(sidekick, value.sidekickThinkingLevel),
	};
	return { config, lead, sidekick };
}
