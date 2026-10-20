import {
	effectiveModelLimits, MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_TOKEN_LIMIT,
	normalizeThinkingLevels, type ModelProfileSummary, type ModelTokenLimits,
} from "../../../shared/settings";
import type { ThinkingLevel } from "../../../shared/agent";

export interface ModelSettingsChange {
	/** An omitted field keeps each model's current value; null restores automatic limits. */
	limits?: Partial<ModelTokenLimits> | null;
	thinking?: ThinkingLevel[] | null;
}

/** Build one atomic profile update for either a single model or a selection. */
export function applyModelSettings(profile: ModelProfileSummary, modelIds: readonly string[], change: ModelSettingsChange) {
	const modelOverrides = structuredClone(profile.modelOverrides ?? {});
	const modelThinking = structuredClone(profile.modelThinking ?? {});
	for (const [key, max] of [["contextWindow", MAX_CONTEXT_WINDOW], ["maxTokens", MAX_OUTPUT_TOKENS]] as const) {
		const value = change.limits?.[key];
		if (value !== undefined && (!Number.isInteger(value) || value < MIN_TOKEN_LIMIT || value > max)) throw new Error(`Invalid ${key}`);
	}
	const thinking = change.thinking === undefined || change.thinking === null ? change.thinking : normalizeThinkingLevels(change.thinking);
	if (change.thinking && !thinking) throw new Error("Invalid thinking levels");
	for (const id of new Set(modelIds)) {
		if (!profile.modelIds.includes(id)) continue;
		if (change.limits === null) delete modelOverrides[id];
		else if (change.limits && (change.limits.contextWindow !== undefined || change.limits.maxTokens !== undefined)) {
			const current = effectiveModelLimits(profile, id);
			modelOverrides[id] = { contextWindow: change.limits.contextWindow ?? current.contextWindow,
				maxTokens: change.limits.maxTokens ?? current.maxTokens };
		}
		if (thinking === null) delete modelThinking[id];
		else if (thinking) modelThinking[id] = [...thinking];
	}
	return { modelOverrides, modelThinking };
}
