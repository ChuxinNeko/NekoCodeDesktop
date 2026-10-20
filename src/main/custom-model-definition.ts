import type { Api, Model } from "@earendil-works/pi-ai";
import { effectiveModelLimits, effectiveThinkingLevels } from "../shared/settings";
import type { RegistrationProfile } from "./model-config-service";
import { modelInputList, thinkingRegistration } from "./model-config-store";

/** Preserve request-format metadata when a built-in model is served by a custom endpoint. */
export function customModelDefinition(profile: RegistrationProfile, id: string, catalog: readonly Model<Api>[]) {
	const limits = effectiveModelLimits(profile, id);
	const thinking = thinkingRegistration(effectiveThinkingLevels(profile, id), profile.reasoning);
	if (profile.api !== "anthropic-messages") {
		return { id, name: id, api: profile.api, ...thinking, input: modelInputList(profile.imageInput),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...limits };
	}
	// Consult the already-loaded runtime catalog, so existing saved profiles are
	// fixed without another fetch or any startup network request.
	const matches = catalog.filter((model): model is Model<"anthropic-messages"> => model.id === id && model.api === "anthropic-messages");
	const reference = matches.find((model) => model.provider === "anthropic") ?? matches[0];
	const detected = profile.modelCapabilities?.[id]?.anthropicThinking;
	const adaptive = detected?.adaptive ?? reference?.compat?.forceAdaptiveThinking;
	const disabled = detected?.disabled ?? (reference ? reference.thinkingLevelMap?.off !== null : undefined);
	const thinkingLevelMap = { ...reference?.thinkingLevelMap, ...thinking.thinkingLevelMap };
	if (disabled === false) thinkingLevelMap.off = null;
	return { id, name: id, api: profile.api, ...thinking, thinkingLevelMap,
		...(adaptive !== undefined ? { compat: { forceAdaptiveThinking: adaptive } } : {}),
		input: modelInputList(profile.imageInput), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...limits };
}
