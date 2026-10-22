/**
 * Apply provider routing to the files the CLIs actually read, as CC Switch does.
 * Key ownership follows demo/cc-switch/src-tauri/src/live/floor.rs (MIT).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { patchProviderToml } from "./native-toml";
import { getAcpProviderState, isRecord, parseProviderConfig, providerFields } from "../../shared/acp-providers";
import type { AcpProviderProfile, AcpProviderState } from "../../shared/acp";
import type { AcpAgentDefinition } from "./agents";

const CLAUDE_TOP = ["apiKeyHelper", "apiBaseUrl", "primaryModel", "smallFastModel", "apiKey", "model", "fallbackModel", "modelOverrides", "modelPicker", "advisorModel", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"];
const CLAUDE_ENV = new Set(["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS"]);
const CLAUDE_EXCLUSIVE = new Set(["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_DISABLE_ARTIFACT", "ENABLE_TOOL_SEARCH", "CLAUDE_CODE_DISABLE_THINKING", "DISABLE_INTERLEAVED_THINKING", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING", "CLAUDE_CODE_AUTO_MODE_SERVER", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_1M_CONTEXT", "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]);
const CLAUDE_PROTOCOL = new Set(["BEDROCK", "VERTEX", "FOUNDRY", "GATEWAY", "MANTLE", "ANTHROPIC_AWS", "ANTHROPIC_GOOGLE_CLOUD"].map((name) => `CLAUDE_CODE_USE_${name}`));
const CODEX_TOP = ["model_provider", "openai_base_url", "model", "review_model", "model_reasoning_effort", "plan_mode_reasoning_effort", "disable_response_storage", "model_catalog_json", "experimental_bearer_token", "base_url", "wire_api"];
const CODEX_EXCLUSIVE = ["web_search", "model_context_window", "model_auto_compact_token_limit", "model_supports_reasoning_summaries", "model_verbosity"];

export function claudeProviderEnvKey(key: string): boolean {
	return /^(ANTHROPIC_|AWS_|VERTEX_REGION_)/.test(key) || CLAUDE_ENV.has(key) || CLAUDE_PROTOCOL.has(key) || /^CLAUDE_CODE_SKIP_.*_AUTH$/.test(key);
}

function selected(agent?: AcpAgentDefinition): AcpProviderProfile | undefined {
	if (!agent) return undefined;
	const state = getAcpProviderState(agent);
	return state.profiles.find((profile) => profile.id === state.activeId);
}

/** These values must come from native files, rather than a stale process override. */
export function nativeConfigEnvKey(agentId: string, key: string): boolean {
	const name = key.toUpperCase();
	return agentId === "claude" ? claudeProviderEnvKey(name) || CLAUDE_EXCLUSIVE.has(name) || ["DEFAULT_AUTH_REQUEST", "CLAUDE_MODEL_CONFIG"].includes(name)
		: agentId === "codex" && ["CODEX_CONFIG", "MODEL_PROVIDER", "OPENAI_BASE_URL", "OPENAI_API_KEY", "CODEX_API_KEY", "NEKOCODE_ACP_API_KEY", "DEFAULT_AUTH_REQUEST"].includes(name);
}

export function nativeConfigEnvironment(agent: AcpAgentDefinition): Record<string, string> {
	const env = { ...agent.env, ...selected(agent)?.env };
	return ownsNativeRouting(agent) ? Object.fromEntries(Object.entries(env).filter(([key]) => !nativeConfigEnvKey(agent.id, key))) : env;
}

/** An imported original configuration retains the CLI's original ambient credentials. */
export function ownsNativeRouting(agent: AcpAgentDefinition): boolean { return selected(agent)?.category !== "current"; }

interface FileChange { path: string; before: Buffer | null; after: string }

/** Injectable home/env keep tests entirely outside the real CLI configuration. */
export class AcpNativeConfig {
	constructor(private readonly options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}) {}

	private directory(agent: AcpAgentDefinition): string {
		const name = agent.id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
		const env = { ...(this.options.env ?? process.env), ...agent.env, ...selected(agent)?.env };
		const key = Object.keys(env).find((entry) => entry.toUpperCase() === name && env[entry]);
		const home = this.options.homeDir ?? homedir();
		const value = key ? env[key] : undefined;
		return value ? resolve(value.replace(/^~(?=[\\/]|$)/, home)) : join(home, agent.id === "claude" ? ".claude" : ".codex");
	}

	private read(path: string): Buffer | null {
		try { return readFileSync(path); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private json(path: string, bytes = this.read(path)): Record<string, unknown> {
		if (!bytes) return {};
		const value: unknown = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
		if (!isRecord(value)) throw new Error(`配置文件必须是对象：${path}`);
		return value;
	}

	importCurrent(agent: AcpAgentDefinition): AcpProviderState | undefined {
		if (agent.id !== "claude" && agent.id !== "codex") return undefined;
		const root = this.directory(agent);
		const profile = getAcpProviderState(agent).profiles[0];
		if (agent.id === "claude") {
			const config = this.json(join(root, "settings.json"));
			const env = isRecord(config.env) ? config.env : {};
			return { activeId: profile.id, profiles: [{ ...profile, config: JSON.stringify(config, null, 2), apiKey: String(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "") }] };
		}
		const config = this.read(join(root, "config.toml"))?.toString("utf8") ?? "";
		const parsed = parseProviderConfig("codex", config);
		const auth = this.json(join(root, "auth.json"));
		const providers = isRecord(parsed.model_providers) ? parsed.model_providers : {};
		const route = providers[String(parsed.model_provider ?? "")];
		const apiKey = isRecord(route) ? (typeof route.experimental_bearer_token === "string" ? route.experimental_bearer_token : "") : typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
		return { activeId: profile.id, profiles: [{ ...profile, config: config || "# Imported empty Codex configuration\n", apiKey }] };
	}

	/** Commit native files before the provider pointer. The caller can roll back on store failure. */
	apply(agent: AcpAgentDefinition, previous?: AcpAgentDefinition): () => void {
		if (agent.id !== "claude" && agent.id !== "codex") return () => {};
		const profile = selected(agent);
		if (!profile) return () => {};
		if (previous && this.directory(previous) === this.directory(agent) && isDeepStrictEqual(selected(previous), profile)) return () => {};
		// An empty imported card means "use the current native config", not "erase it".
		if (profile.category === "current" && !profile.config.trim()) return () => {};
		const root = this.directory(agent);
		const changes = agent.id === "claude" ? this.claude(root, profile, selected(previous)) : this.codex(root, profile, selected(previous));
		const written: FileChange[] = [];
		const rollback = () => {
			for (const change of written.slice().reverse()) {
				if (change.before) this.atomicWrite(change.path, change.before);
				else rmSync(change.path, { force: true });
			}
		};
		try {
			for (const change of changes) {
				if (change.before?.equals(Buffer.from(change.after))) continue;
				if (change.before) {
					const backup = `${change.path}.nekocode.bak`;
					if (!existsSync(backup)) this.atomicWrite(backup, change.before);
					else if (!statSync(backup).isFile()) throw new Error(`配置备份路径不是文件：${backup}`);
				}
				this.atomicWrite(change.path, change.after);
				written.push(change);
			}
		} catch (error) { rollback(); throw error; }
		return rollback;
	}

	private atomicWrite(path: string, bytes: string | Buffer): void {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.tmp-${randomUUID()}`;
		try { writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, path); }
		finally { rmSync(temporary, { force: true }); }
	}

	private claude(root: string, profile: AcpProviderProfile, previous?: AcpProviderProfile): FileChange[] {
		const path = join(root, "settings.json");
		const before = this.read(path);
		const live = this.json(path, before);
		const target = parseProviderConfig("claude", profile.config);
		const old = previous ? parseProviderConfig("claude", previous.config) : {};
		const env = { ...(isRecord(live.env) ? live.env : {}) };
		const oldEnv = { ...previous?.env, ...(isRecord(old.env) ? old.env : {}) };
		const targetEnv = { ...profile.env, ...(isRecord(target.env) ? target.env : {}) };
		for (const key of Object.keys(env)) {
			if (claudeProviderEnvKey(key) || (CLAUDE_EXCLUSIVE.has(key) && env[key] === oldEnv[key])) delete env[key];
		}
		for (const [key, value] of Object.entries(targetEnv)) {
			if (claudeProviderEnvKey(key) || CLAUDE_EXCLUSIVE.has(key)) env[key] = value;
		}
		if (profile.apiKey) env[providerFields("claude", profile).apiKeyField] = profile.apiKey;
		const next: Record<string, unknown> = { ...live };
		if (Object.keys(env).length || "env" in live || "env" in target) next.env = env;
		for (const key of CLAUDE_TOP) { delete next[key]; if (key in target) next[key] = target[key]; }
		return isDeepStrictEqual(live, next) ? [] : [{ path, before, after: `${JSON.stringify(next, null, 2)}\n` }];
	}

	private codex(root: string, profile: AcpProviderProfile, previous?: AcpProviderProfile): FileChange[] {
		const path = join(root, "config.toml");
		const before = this.read(path);
		const live = structuredClone(parseProviderConfig("codex", before?.toString("utf8") ?? ""));
		const target = structuredClone(parseProviderConfig("codex", profile.config));
		const old = previous ? structuredClone(parseProviderConfig("codex", previous.config)) : {};
		const next = structuredClone(live);
		for (const key of CODEX_TOP) { delete next[key]; if (key in target) next[key] = target[key]; }
		for (const key of CODEX_EXCLUSIVE) {
			if (key in old && isDeepStrictEqual(next[key], old[key])) delete next[key];
			if (key in target) next[key] = target[key];
		}
		const providers = isRecord(next.model_providers) ? { ...next.model_providers } : {};
		const targetProviders = isRecord(target.model_providers) ? target.model_providers : {};
		const providerId = typeof target.model_provider === "string" ? target.model_provider : "";
		const route = isRecord(targetProviders[providerId]) ? { ...targetProviders[providerId] } : {};
		const official = profile.category === "official" || (profile.category === "current" && (!providerId || providerId === "openai"));
		delete providers.custom;
		// These reserved built-in tables make recent Codex versions reject the file.
		for (const reserved of ["openai", "ollama", "lmstudio"]) delete providers[reserved];
		if (!official && (route.base_url || target.openai_base_url || target.base_url)) {
			delete next.openai_base_url;
			delete next.base_url;
			delete next.experimental_bearer_token;
			next.model_provider = "custom";
			Object.assign(route, { name: route.name || profile.name, base_url: route.base_url || target.openai_base_url || target.base_url, wire_api: "responses", requires_openai_auth: false });
			if (profile.apiKey) { delete route.env_key; route.experimental_bearer_token = profile.apiKey; }
			providers.custom = route;
		} else if (official) delete next.model_provider;
		if (Object.keys(providers).length) next.model_providers = providers;
		else delete next.model_providers;
		const changes: FileChange[] = isDeepStrictEqual(live, next) ? [] : [{ path, before, after: patchProviderToml(before?.toString("utf8") ?? "", live, next) }];
		// Third-party keys belong in the route table. Never overwrite a saved OAuth login.
		if (official) {
			const authPath = join(root, "auth.json");
			const authBefore = this.read(authPath);
			const auth = this.json(authPath, authBefore);
			const nextAuth = { ...auth };
			if (profile.apiKey) { nextAuth.OPENAI_API_KEY = profile.apiKey; nextAuth.auth_mode = "apikey"; }
			else { delete nextAuth.OPENAI_API_KEY; if (nextAuth.auth_mode === "apikey") { if (nextAuth.tokens) nextAuth.auth_mode = "chatgpt"; else delete nextAuth.auth_mode; } }
			if (!isDeepStrictEqual(auth, nextAuth)) changes.push({ path: authPath, before: authBefore, after: `${JSON.stringify(nextAuth, null, 2)}\n` });
		}
		return changes;
	}
}
