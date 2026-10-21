/**
 * CC Switch's provider workflow and native configuration formats.
 * Preset snapshots: ../licenses/cc-switch-LICENSE.txt (MIT, Jason Young).
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { AcpAgentConfig, AcpProviderProfile, AcpProviderState } from "./acp";
import snapshots from "./acp-provider-presets.json";

export type AcpPresetGroup = "login" | "vendor" | "thirdparty" | "cloud" | "local";
export interface AcpProviderPreset {
	id: string; name: string; category: string; websiteUrl: string; apiKeyUrl?: string;
	family?: string; familyName?: string; planKey?: string; regionKey?: string;
	icon?: string; iconColor?: string; aliases?: string | string[]; apiFormat?: string;
	requiresOAuth?: boolean; config: string; apiKey: string; apiKeyField: string;
	modelCatalog?: Array<{ model: string; displayName?: string }>;
	endpointCandidates?: string[];
}
export const ACP_PROVIDER_PRESETS = snapshots as unknown as Record<"codex" | "claude", AcpProviderPreset[]>;
export const ACP_PRESET_GROUPS: AcpPresetGroup[] = ["login", "vendor", "thirdparty", "cloud", "local"];
export function presetGroup(preset: { category: string; requiresOAuth?: boolean }): AcpPresetGroup {
	if (preset.category === "official" || preset.requiresOAuth) return "login";
	if (preset.category === "cn_official") return "vendor";
	if (preset.category === "cloud_provider") return "cloud";
	if (preset.category === "local") return "local";
	return "thirdparty";
}
export function presetMatches(preset: AcpProviderPreset, query: string): boolean {
	const text = [preset.name, preset.familyName, preset.websiteUrl, preset.aliases, preset.planKey, preset.regionKey].flat().join(" ").toLowerCase();
	return query.trim().toLowerCase().split(/\s+/).every((word) => text.includes(word));
}
export function presetLimitation(agentId: string, preset: AcpProviderPreset): "routing" | "oauth" | null {
	if (preset.requiresOAuth) return "oauth";
	if (preset.apiFormat && preset.apiFormat !== (agentId === "codex" ? "openai_responses" : "anthropic")) return "routing";
	return null;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
export function parseProviderConfig(agentId: string, config: string): Record<string, unknown> {
	if (!config.trim()) return {};
	const parsed: unknown = agentId === "codex" ? parseToml(config) : JSON.parse(config);
	if (!isRecord(parsed)) throw new Error("配置必须是对象");
	return parsed;
}
export function serializeProviderConfig(agentId: string, config: Record<string, unknown>): string {
	return agentId === "codex" ? stringifyToml(config as Parameters<typeof stringifyToml>[0]) : JSON.stringify(config, null, 2);
}
export interface AcpProviderFields {
	baseUrl: string; model: string; reasoning: string; apiKeyField: string;
	haiku: string; sonnet: string; opus: string; subagent: string;
}
const text = (value: unknown) => typeof value === "string" ? value : "";
export function providerFields(agentId: string, profile: AcpProviderProfile): AcpProviderFields {
	const config = parseProviderConfig(agentId, profile.config);
	if (agentId === "codex") {
		const providers = isRecord(config.model_providers) ? config.model_providers : {};
		const provider = providers[text(config.model_provider)];
		return { baseUrl: isRecord(provider) ? text(provider.base_url) : "", model: text(config.model), reasoning: text(config.model_reasoning_effort), apiKeyField: "OPENAI_API_KEY", haiku: "", sonnet: "", opus: "", subagent: "" };
	}
	const env = isRecord(config.env) ? config.env : {};
	return {
		baseUrl: text(env.ANTHROPIC_BASE_URL), model: text(env.ANTHROPIC_MODEL), reasoning: "",
		apiKeyField: "ANTHROPIC_API_KEY" in env ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN",
		haiku: text(env.ANTHROPIC_DEFAULT_HAIKU_MODEL), sonnet: text(env.ANTHROPIC_DEFAULT_SONNET_MODEL), opus: text(env.ANTHROPIC_DEFAULT_OPUS_MODEL), subagent: text(env.CLAUDE_CODE_SUBAGENT_MODEL),
	};
}
export function updateProviderFields(agentId: string, profile: AcpProviderProfile, patch: Partial<AcpProviderFields> & { apiKey?: string }): AcpProviderProfile {
	const fields = { ...providerFields(agentId, profile), ...patch };
	const apiKey = patch.apiKey ?? profile.apiKey;
	const config = parseProviderConfig(agentId, profile.config);
	if (agentId === "codex") {
		const providerId = text(config.model_provider) || "custom";
		const providers = isRecord(config.model_providers) ? config.model_providers : {};
		const existing = isRecord(providers[providerId]) ? providers[providerId] : {};
		config.model_provider = providerId;
		if (fields.model) config.model = fields.model;
		else delete config.model;
		if (fields.reasoning) config.model_reasoning_effort = fields.reasoning;
		else delete config.model_reasoning_effort;
		config.model_providers = { ...providers, [providerId]: { ...existing, name: text(existing.name) || profile.name || "Custom", base_url: fields.baseUrl, wire_api: "responses" } };
	} else {
		const env = isRecord(config.env) ? { ...config.env } : {};
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
		Object.assign(env, {
			ANTHROPIC_BASE_URL: fields.baseUrl, [fields.apiKeyField]: apiKey, ANTHROPIC_MODEL: fields.model,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: fields.haiku, ANTHROPIC_DEFAULT_SONNET_MODEL: fields.sonnet,
			ANTHROPIC_DEFAULT_OPUS_MODEL: fields.opus, CLAUDE_CODE_SUBAGENT_MODEL: fields.subagent,
		});
		config.env = env;
	}
	return { ...profile, apiKey, config: serializeProviderConfig(agentId, config) };
}
export function profileFromPreset(agentId: string, preset?: AcpProviderPreset): AcpProviderProfile {
	let profile: AcpProviderProfile = {
		id: "", name: preset?.name ?? "", category: preset?.category ?? "custom", presetId: preset?.id,
		websiteUrl: preset?.websiteUrl ?? "", notes: "", config: preset?.config ?? (agentId === "codex" ? "" : '{\n  "env": {}\n}'), apiKey: preset?.apiKey ?? "", env: {},
	};
	if (!preset && (agentId === "codex" || agentId === "claude")) profile = updateProviderFields(agentId, profile, { baseUrl: "", model: "", reasoning: agentId === "codex" ? "high" : "" });
	return profile;
}
/** Preserve the previous release's settings as a normal editable provider card. */
export function getAcpProviderState(agent: AcpAgentConfig): AcpProviderState {
	if (agent.providerState) return agent.providerState;
	const legacy = agent.modelSettings;
	let profile: AcpProviderProfile = { id: "imported", name: "当前配置", category: "current", websiteUrl: "", notes: "", config: "", apiKey: "", env: {} };
	if (legacy && legacy.mode !== "inherit") {
		const preset = ACP_PROVIDER_PRESETS[agent.id as "codex" | "claude"]?.find((entry) => entry.category === "official");
		profile = { ...profileFromPreset(agent.id, legacy.mode === "official" ? preset : undefined), id: "imported", name: legacy.mode === "official" ? (preset?.name ?? "Official") : "已导入配置" };
		profile = updateProviderFields(agent.id, profile, { ...legacy, reasoning: legacy.reasoning ?? "", haiku: legacy.haiku ?? "", sonnet: legacy.sonnet ?? "", opus: legacy.opus ?? "" });
	}
	return { activeId: profile.id, profiles: [profile] };
}
