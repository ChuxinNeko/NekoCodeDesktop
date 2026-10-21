import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACP_PROVIDER_PRESETS, getAcpProviderState, parseProviderConfig, presetMatches, profileFromPreset, providerFields, updateProviderFields } from "../../../src/shared/acp-providers";
import { acpProviderEnv, acpProviderSessionMeta, validateAcpProviderState } from "../../../src/main/acp/providers";
import { AcpConfigStore } from "../../../src/main/acp/config-store";
import { BUILTIN_ACP_AGENTS } from "../../../src/main/acp/agents";
import { agentLaunch } from "../../../src/main/acp/launch";
import type { AcpProviderState } from "../../../src/shared/acp";

const card = (agentId: string) => ({ ...updateProviderFields(agentId, profileFromPreset(agentId), { baseUrl: "https://example.test/v1", model: "custom-model", apiKey: "test-secret" }), id: "custom", name: "Custom" });

describe("saved ACP providers", () => {
	test("CC Switch preset snapshots have parseable native configuration and searchable versions", () => {
		for (const [agentId, presets] of Object.entries(ACP_PROVIDER_PRESETS)) {
			expect(presets.length).toBe(132);
			for (const preset of presets) expect(() => parseProviderConfig(agentId, preset.config)).not.toThrow();
			const kimi = presets.filter((entry) => entry.family === "kimi");
			expect(kimi.length).toBeGreaterThan(1);
			expect(presetMatches(kimi[0], "Kimi")).toBe(true);
		}
	});
	test("structured Codex editing preserves extra native config and env_key authenticates only this process", () => {
		const original = { ...card("codex"), config: card("codex").config + '\n[features]\nexample_flag = true\n' };
		const profile = updateProviderFields("codex", original, { model: "edited", reasoning: "xhigh" });
		expect(parseProviderConfig("codex", profile.config).features).toEqual({ example_flag: true });
		const state = { activeId: profile.id, profiles: [profile] };
		expect(validateAcpProviderState("codex", state)).toMatchObject({ activeId: "custom" });
		const env = acpProviderEnv("codex", state);
		const config = JSON.parse(env.CODEX_CONFIG);
		expect(config.model).toBe("edited");
		expect(config.model_reasoning_effort).toBe("xhigh");
		expect(config.model_providers.custom).toMatchObject({ base_url: "https://example.test/v1", wire_api: "responses", requires_openai_auth: false, env_key: "NEKOCODE_ACP_API_KEY" });
		expect(env.NEKOCODE_ACP_API_KEY).toBe("test-secret");
		expect(env.CODEX_CONFIG).not.toContain("test-secret");
	});
	test("Claude editing synchronizes auth field, model mappings and raw settings without losing extras", () => {
		const original = { ...card("claude"), config: JSON.stringify({ env: { KEEP: "yes", ANTHROPIC_AUTH_TOKEN: "old" }, permissions: { defaultMode: "default" } }) };
		const profile = updateProviderFields("claude", original, { baseUrl: "https://example.test", apiKeyField: "ANTHROPIC_API_KEY", apiKey: "new", model: "main", haiku: "small", sonnet: "middle", opus: "large", subagent: "worker" });
		const config = parseProviderConfig("claude", profile.config);
		expect(config.permissions).toEqual({ defaultMode: "default" });
		const meta = acpProviderSessionMeta("claude", { activeId: profile.id, profiles: [profile] }, { systemPrompt: { append: "keep" } });
		expect(meta).toEqual({ systemPrompt: { append: "keep" }, claudeCode: { options: { settings: { permissions: { defaultMode: "default" } } } } });
		expect(JSON.stringify(meta)).not.toContain('"new"');
		const env = acpProviderEnv("claude", { activeId: profile.id, profiles: [profile] });
		expect(env).toMatchObject({ KEEP: "yes", ANTHROPIC_API_KEY: "new", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_MODEL: "main", ANTHROPIC_DEFAULT_HAIKU_MODEL: "small", ANTHROPIC_DEFAULT_SONNET_MODEL: "middle", ANTHROPIC_DEFAULT_OPUS_MODEL: "large", CLAUDE_CODE_SUBAGENT_MODEL: "worker" });
	});
	test("official and custom providers persist independently, with the selected provider reaching launch", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-providers-"));
		try {
			const store = new AcpConfigStore(dir);
			const agent = store.find("codex")!;
			const official = { ...profileFromPreset("codex", ACP_PROVIDER_PRESETS.codex.find((entry) => entry.category === "official")), id: "official" };
			const custom = card("codex");
			const providerState = { activeId: custom.id, profiles: [official, custom] };
			store.save({ ...agent, providerState });
			const { providerState: _, ...config } = store.find("codex")!;
			store.save({ ...config, enabled: false });
			expect(new AcpConfigStore(dir).find("codex")?.providerState).toEqual(validateAcpProviderState("codex", providerState));
			const context = { execPath: "/electron", appRoot: "/app", platform: "linux" as const, baseEnv: {}, findCli: () => "/codex", fileExists: () => true };
			const launch = agentLaunch({ ...agent, providerState }, context);
			expect(JSON.parse(launch.env.CODEX_CONFIG).model).toBe("custom-model");
			const env = acpProviderEnv("codex", { ...providerState, activeId: official.id });
			expect(env.MODEL_PROVIDER).toBe("openai");
			expect(env.NEKOCODE_ACP_API_KEY).toBe("");
			expect(JSON.parse(env.CODEX_CONFIG).model_providers.openai.requires_openai_auth).toBe(true);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	test("legacy routing migrates into an editable saved provider without dropping keys or models", () => {
		const agent = { ...BUILTIN_ACP_AGENTS[0], modelSettings: { mode: "custom" as const, baseUrl: "https://example.test/v1", apiKey: "old-key", model: "old-model", reasoning: "high" as const } };
		const state = getAcpProviderState(agent);
		expect(state.profiles[0].apiKey).toBe("old-key");
		expect(providerFields("codex", state.profiles[0]).model).toBe("old-model");
		expect(() => validateAcpProviderState("codex", state)).not.toThrow();
	});
	test("imported configurations accept partial CLI overrides and native agents keep their own environment schema", () => {
		expect(parseProviderConfig("codex", profileFromPreset("codex").config).model).toBeUndefined();
		const imported = { ...getAcpProviderState(BUILTIN_ACP_AGENTS[0]).profiles[0], config: 'model = "selected"' };
		const env = acpProviderEnv("codex", { activeId: imported.id, profiles: [imported] });
		expect(JSON.parse(env.CODEX_CONFIG)).toEqual({ model: "selected" });
		expect(env.MODEL_PROVIDER).toBeUndefined();
		const native = { ...profileFromPreset("droid"), id: "native", name: "Factory", env: { FACTORY_API_KEY: "test-key" } };
		expect(native.config).not.toContain("ANTHROPIC");
		expect(acpProviderEnv("droid", { activeId: native.id, profiles: [native] })).toEqual({ FACTORY_API_KEY: "test-key" });
	});

	test("validation rejects invalid active IDs, duplicates, invalid native config and unsupported direct protocols", () => {
		const profile = card("codex");
		const state: AcpProviderState = { activeId: profile.id, profiles: [profile] };
		expect(() => validateAcpProviderState("codex", { ...state, activeId: "gone" })).toThrow();
		expect(() => validateAcpProviderState("codex", { ...state, profiles: [profile, profile] })).toThrow();
		expect(() => validateAcpProviderState("codex", { ...state, profiles: [{ ...profile, config: "broken = [" }] })).toThrow();
		expect(() => validateAcpProviderState("codex", { ...state, profiles: [{ ...profile, config: profile.config.replace('wire_api = "responses"', 'wire_api = "chat"') }] })).toThrow();
	});
});
