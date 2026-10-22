import type { AcpAgentConfig, AcpModelSettings } from "../../shared/acp";
import { isRecord, parseProviderConfig } from "../../shared/acp-providers";

/** Resolve Claude's picker aliases for usage labels, without changing ACP control values. */
export function acpUsageModel(agent: Pick<AcpAgentConfig, "id" | "env" | "modelSettings" | "providerState">, model: string): string {
	if (agent.id !== "claude") return model;
	const profile = agent.providerState?.profiles.find((entry) => entry.id === agent.providerState?.activeId);
	const config = profile ? parseProviderConfig("claude", profile.config) : {};
	const env = { ...acpModelEnv("claude", agent.modelSettings), ...agent.env, ...profile?.env, ...(isRecord(config.env) ? config.env : {}) };
	let current = model;
	if (!current || current === "default") {
		const configured = env.ANTHROPIC_MODEL || config.model;
		if (typeof configured === "string" && configured.trim()) current = configured.trim();
	}
	const alias = /^(opus|sonnet|haiku)(?:\[(?:1m|200k)\])?$/i.exec(current);
	if (!alias) return current;
	const mapped = env[`ANTHROPIC_DEFAULT_${alias[1].toUpperCase()}_MODEL`];
	return typeof mapped === "string" && mapped.trim() ? mapped.trim() : current;
}

export function validateAcpModelSettings(agentId: string, raw: unknown): AcpModelSettings {
	if (agentId !== "codex" && agentId !== "claude") throw new Error("此代理请通过环境变量配置模型");
	if (!raw || typeof raw !== "object") throw new Error("无效的 ACP 模型配置");
	const value = raw as Record<string, unknown>;
	if (!["inherit", "official", "custom"].includes(String(value.mode))) throw new Error("无效的供应商模式");
	const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).trim() : "";
	const config: AcpModelSettings = {
		mode: value.mode as AcpModelSettings["mode"], baseUrl: text("baseUrl"), apiKey: text("apiKey"), model: text("model"),
		reasoning: text("reasoning") as AcpModelSettings["reasoning"], haiku: text("haiku"), sonnet: text("sonnet"), opus: text("opus"),
	};
	if (!["", "low", "medium", "high", "xhigh"].includes(config.reasoning ?? "")) throw new Error("无效的推理强度");
	if (config.mode === "custom") {
		let url: URL;
		try { url = new URL(config.baseUrl); } catch { throw new Error("请输入有效的 API 地址"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("API 地址必须为 HTTP(S) 地址，且不能包含凭据、查询参数或片段");
		if (!config.apiKey || !config.model) throw new Error("请填写 API Key 和模型 ID");
	}
	return config;
}

/** Adapter-supported overrides take precedence over manually configured routing. */
export function acpModelEnv(agentId: string, config?: AcpModelSettings): Record<string, string> {
	if (!config || config.mode === "inherit") return {};
	if (agentId === "codex") {
		const custom = config.mode === "custom";
		const provider = custom ? "nekocode" : "openai";
		return {
			MODEL_PROVIDER: provider,
			CODEX_CONFIG: JSON.stringify({
				model_provider: provider,
				...(config.model ? { model: config.model } : {}),
				...(config.reasoning ? { model_reasoning_effort: config.reasoning } : {}),
				model_providers: {
					[provider]: { name: custom ? "NekoCode API" : "OpenAI", base_url: custom ? config.baseUrl : "https://api.openai.com/v1", wire_api: "responses", ...(config.apiKey ? { env_key: "NEKOCODE_ACP_API_KEY", requires_openai_auth: false } : { requires_openai_auth: true }) },
				},
			}),
			NEKOCODE_ACP_API_KEY: config.apiKey,
			CODEX_API_KEY: config.apiKey,
			OPENAI_API_KEY: config.apiKey,
			// env_key authenticates requests without invoking the CLI login flow.
			DEFAULT_AUTH_REQUEST: "",
		};
	}
	if (agentId === "claude") return {
		ANTHROPIC_BASE_URL: config.mode === "custom" ? config.baseUrl : "https://api.anthropic.com",
		ANTHROPIC_API_KEY: config.apiKey,
		ANTHROPIC_AUTH_TOKEN: "",
		...(config.apiKey ? { CLAUDE_CODE_OAUTH_TOKEN: "" } : {}),
		CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "",
		ANTHROPIC_MODEL: config.model,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: config.haiku ?? "",
		ANTHROPIC_DEFAULT_SONNET_MODEL: config.sonnet ?? "",
		ANTHROPIC_DEFAULT_OPUS_MODEL: config.opus ?? "",
	};
	return {};
}
