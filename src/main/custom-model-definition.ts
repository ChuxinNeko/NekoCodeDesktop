import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { effectiveModelLimits, effectiveThinkingLevels } from "../shared/settings";
import type { RegistrationProfile } from "./model-config-service";
import {
	capabilitiesFromMatches, preferCatalogCapabilities, preferredBuiltinProvider, selectCatalogModels,
} from "./model-capabilities";
import { modelInputList, thinkingRegistration } from "./model-config-store";

/** One catalog row, or several that describe thinking the same way. */
function agreedThinkingModel(matches: readonly Model<Api>[]): Model<Api> | undefined {
	if (matches.length === 1) return matches[0];
	if (!matches.length) return undefined;
	const first = matches[0];
	const same = matches.every((model) => model.reasoning === first.reasoning
		&& JSON.stringify(model.thinkingLevelMap ?? null) === JSON.stringify(first.thinkingLevelMap ?? null));
	return same ? first : undefined;
}

/**
 * Register a custom endpoint's model with pi's built-in context window and
 * thinking map when the user has not overridden them. Manual per-model settings
 * still win; endpoint metadata fills only the fields the catalog does not know.
 */
export function customModelDefinition(
	profile: RegistrationProfile,
	id: string,
	catalog: readonly Model<Api>[],
	getLevels: (model: Model<Api>) => string[] = getSupportedThinkingLevels,
) {
	const matches = selectCatalogModels(catalog, id, {
		api: profile.api,
		provider: preferredBuiltinProvider(profile.sdkBaseUrl),
	});
	const builtin = capabilitiesFromMatches(matches, getLevels);
	const merged = preferCatalogCapabilities(profile.modelCapabilities?.[id], builtin);
	const view = merged
		? { ...profile, modelCapabilities: { ...profile.modelCapabilities, [id]: merged } }
		: profile;
	const limits = effectiveModelLimits(view, id);
	const manualThinking = profile.modelThinking[id];
	const thinking = thinkingRegistration(effectiveThinkingLevels(view, id), profile.reasoning);
	const reference = agreedThinkingModel(matches);
	if (!manualThinking && reference?.reasoning && reference.thinkingLevelMap) {
		thinking.reasoning = true;
		thinking.thinkingLevelMap = reference.thinkingLevelMap;
	} else if (!manualThinking && reference && !reference.reasoning) {
		thinking.reasoning = false;
		delete thinking.thinkingLevelMap;
	} else if (manualThinking && thinking.reasoning && reference?.thinkingLevelMap) {
		thinking.thinkingLevelMap = { ...reference.thinkingLevelMap, ...thinking.thinkingLevelMap };
	}
	const defined = { id, name: id, api: profile.api, ...thinking, input: modelInputList(profile.imageInput),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...limits };
	if (profile.api !== "anthropic-messages") return defined;
	// Request-format flags still come from the Anthropic-shaped catalog row.
	const anthropic = matches.find((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages");
	const detected = view.modelCapabilities?.[id]?.anthropicThinking;
	const adaptive = detected?.adaptive ?? anthropic?.compat?.forceAdaptiveThinking;
	const disabled = detected?.disabled ?? (anthropic ? anthropic.thinkingLevelMap?.off !== null : undefined);
	const thinkingLevelMap = { ...anthropic?.thinkingLevelMap, ...thinking.thinkingLevelMap };
	if (disabled === false) thinkingLevelMap.off = null;
	return { ...defined, thinkingLevelMap,
		...(adaptive !== undefined ? { compat: { forceAdaptiveThinking: adaptive } } : {}) };
}
