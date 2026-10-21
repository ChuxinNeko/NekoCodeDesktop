import type { AcpProviderProfile, AcpProviderState } from "../../shared/acp";
import { isRecord, parseProviderConfig, providerFields } from "../../shared/acp-providers";
import { validateBaseUrl } from "../model-endpoint";
import { acpModelEnv } from "./model-settings";

export function validateAcpProviderState(agentId: string, raw: unknown): AcpProviderState {
	if (!isRecord(raw) || !Array.isArray(raw.profiles) || typeof raw.activeId !== "string") throw new Error("无效的供应商配置");
	const ids = new Set<string>();
	const profiles = raw.profiles.map((entry: unknown): AcpProviderProfile => {
		if (!isRecord(entry)) throw new Error("无效的供应商");
		const string = (key: string) => typeof entry[key] === "string" ? (entry[key] as string).trim() : "";
		const id = string("id");
		if (!id || ids.has(id)) throw new Error("供应商 ID 无效或重复");
		ids.add(id);
		const name = string("name");
		if (!name) throw new Error("请填写供应商名称");
		const category = string("category") || "custom";
		const env = isRecord(entry.env) ? entry.env : {};
		if (Object.values(env).some((value) => typeof value !== "string")) throw new Error("环境变量必须为字符串");
		const profile: AcpProviderProfile = { id, name, category, websiteUrl: string("websiteUrl"), notes: string("notes"), config: string("config"), apiKey: string("apiKey"), env: { ...env } as Record<string, string>, ...(string("presetId") ? { presetId: string("presetId") } : {}) };
		const config = parseProviderConfig(agentId, profile.config);
		if (config.env !== undefined && (!isRecord(config.env) || Object.values(config.env).some((value) => typeof value !== "string"))) throw new Error("配置中的 env 必须为字符串键值对");
		if (agentId === "codex" || agentId === "claude") {
			const fields = providerFields(agentId, profile);
			if (category !== "official" && category !== "current") validateBaseUrl(fields.baseUrl);
			else if (fields.baseUrl) validateBaseUrl(fields.baseUrl);
			if (agentId === "codex") {
				const providers = isRecord(config.model_providers) ? config.model_providers : {};
				const provider = providers[typeof config.model_provider === "string" ? config.model_provider : ""];
				if (isRecord(provider) && provider.wire_api && provider.wire_api !== "responses") throw new Error("Codex ACP 直连需要 OpenAI Responses 协议");
			} else if (config.env !== undefined && (!isRecord(config.env) || Object.values(config.env).some((value) => typeof value !== "string"))) {
				throw new Error("Claude settings.json 中的 env 必须为字符串键值对");
			}
		}
		return profile;
	});
	if (!ids.has(raw.activeId)) throw new Error("请选择有效的当前供应商");
	return { activeId: raw.activeId, profiles };
}

/** Resolve the selected saved card into this agent process's configuration. */
export function acpProviderEnv(agentId: string, state: AcpProviderState): Record<string, string> {
	const profile = state.profiles.find((entry) => entry.id === state.activeId);
	if (!profile) throw new Error("当前供应商不存在");
	if (profile.category === "current" && !profile.config.trim()) return { ...profile.env };
	const config = parseProviderConfig(agentId, profile.config);
	if (profile.category === "current") return {
		...profile.env,
		...(agentId === "codex" ? { CODEX_CONFIG: JSON.stringify(config), ...(typeof config.model_provider === "string" ? { MODEL_PROVIDER: config.model_provider } : {}) }
			: isRecord(config.env) ? config.env as Record<string, string> : {}),
	};
	const official = profile.category === "official";
	if (agentId === "codex") {
		if (official) return {
			...profile.env,
			...acpModelEnv("codex", { mode: "official", baseUrl: "", apiKey: profile.apiKey, model: typeof config.model === "string" ? config.model : "", reasoning: config.model_reasoning_effort as "high" | undefined }),
			OPENAI_BASE_URL: "",
		};
		const fields = providerFields(agentId, profile);
		const providerId = typeof config.model_provider === "string" ? config.model_provider : "custom";
		const providers = isRecord(config.model_providers) ? config.model_providers : {};
		const provider = isRecord(providers[providerId]) ? { ...providers[providerId] } : {};
		// Authenticate each request through the environment, without `codex login`.
		delete provider.env_key;
		delete provider.experimental_bearer_token;
		Object.assign(provider, { base_url: fields.baseUrl, wire_api: "responses", requires_openai_auth: false, ...(profile.apiKey ? { env_key: "NEKOCODE_ACP_API_KEY" } : {}) });
		return {
			...profile.env,
			MODEL_PROVIDER: providerId,
			CODEX_CONFIG: JSON.stringify({ ...config, model_provider: providerId, model_providers: { ...providers, [providerId]: provider } }),
			NEKOCODE_ACP_API_KEY: profile.apiKey, CODEX_API_KEY: profile.apiKey, OPENAI_API_KEY: profile.apiKey,
			OPENAI_BASE_URL: "", DEFAULT_AUTH_REQUEST: "",
		};
	}
	if (agentId === "claude") {
		const env = isRecord(config.env) ? config.env as Record<string, string> : {};
		const fields = providerFields(agentId, profile);
		const authField = fields.apiKeyField;
		return {
			...profile.env,
			...acpModelEnv("claude", { mode: official ? "official" : "custom", baseUrl: fields.baseUrl, apiKey: profile.apiKey, model: fields.model }),
			...env,
			...(official ? { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } : { [authField]: profile.apiKey }),
		};
	}
	return { ...profile.env, ...(isRecord(config.env) ? config.env as Record<string, string> : {}) };
}

/** Claude SDK settings accompany session/new, while credentials remain in env. */
export function acpProviderSessionMeta(agentId: string, state: AcpProviderState | undefined, base: Record<string, unknown> = {}): Record<string, unknown> {
	if (agentId !== "claude" || !state) return base;
	const profile = state.profiles.find((entry) => entry.id === state.activeId);
	if (!profile?.config) return base;
	const { env: _, ...settings } = parseProviderConfig(agentId, profile.config);
	if (!Object.keys(settings).length) return base;
	const claudeCode = isRecord(base.claudeCode) ? base.claudeCode : {};
	const options = isRecord(claudeCode.options) ? claudeCode.options : {};
	return { ...base, claudeCode: { ...claudeCode, options: { ...options, settings } } };
}
