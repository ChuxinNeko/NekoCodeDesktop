import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpModelEnv, validateAcpModelSettings } from "../../../src/main/acp/model-settings";
import { AcpConfigStore } from "../../../src/main/acp/config-store";
import { agentLaunch } from "../../../src/main/acp/launch";
import { BUILTIN_ACP_AGENTS } from "../../../src/main/acp/agents";
import type { AcpModelSettings } from "../../../src/shared/acp";

const custom: AcpModelSettings = { mode: "custom", baseUrl: "https://gateway.example/v1", apiKey: "test-secret", model: "custom-model", reasoning: "high" };

describe("ACP model routing", () => {
	test("custom Codex launches with Responses routing and a process-only API key", () => {
		const agent = { ...BUILTIN_ACP_AGENTS.find((entry) => entry.id === "codex")!, modelSettings: custom, env: { MODEL_PROVIDER: "old", CODEX_CONFIG: "{}", KEEP: "yes" } };
		const launch = agentLaunch(agent, { execPath: "/electron", appRoot: "/app", platform: "linux", baseEnv: {}, findCli: () => "/codex", fileExists: () => true });
		const config = JSON.parse(launch.env.CODEX_CONFIG);
		expect(config.model).toBe("custom-model");
		expect(config.model_reasoning_effort).toBe("high");
		expect(config.model_providers.nekocode).toMatchObject({ base_url: custom.baseUrl, wire_api: "responses", env_key: "NEKOCODE_ACP_API_KEY", requires_openai_auth: false });
		expect(launch.env.NEKOCODE_ACP_API_KEY).toBe(custom.apiKey);
		expect(launch.env.KEEP).toBe("yes");
		expect(launch.env.CODEX_CONFIG).not.toContain(custom.apiKey);
		expect(agent.env.MODEL_PROVIDER).toBe("old");
	});
	test("official Codex selects official routing and supports existing login", () => {
		const env = acpModelEnv("codex", { ...custom, mode: "official", apiKey: "" });
		expect(env.MODEL_PROVIDER).toBe("openai");
		expect(JSON.parse(env.CODEX_CONFIG).model_providers.openai).toMatchObject({ base_url: "https://api.openai.com/v1", requires_openai_auth: true });
		expect(env.CODEX_API_KEY).toBe("");
	});
	test("Claude maps model families and removes conflicting API authentication", () => {
		const env = acpModelEnv("claude", { ...custom, haiku: "small", sonnet: "medium", opus: "large" });
		expect(env).toMatchObject({ ANTHROPIC_BASE_URL: custom.baseUrl, ANTHROPIC_MODEL: custom.model, ANTHROPIC_API_KEY: custom.apiKey, ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_DEFAULT_HAIKU_MODEL: "small", ANTHROPIC_DEFAULT_SONNET_MODEL: "medium", ANTHROPIC_DEFAULT_OPUS_MODEL: "large" });
		expect(acpModelEnv("claude", { ...custom, mode: "official" }).ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
		expect(acpModelEnv("codex", { ...custom, mode: "inherit" })).toEqual({});
	});
	test("validates custom routing before saving", () => {
		for (const baseUrl of ["bad", "file:///tmp/config", "https://user:pass@example.com", "https://example.com?key=secret"]) {
			expect(() => validateAcpModelSettings("codex", { ...custom, baseUrl })).toThrow();
		}
		expect(() => validateAcpModelSettings("claude", { ...custom, model: "" })).toThrow();
		expect(() => validateAcpModelSettings("cursor", custom)).toThrow();
	});
	test("persists models through launch edits, toggles and reloads; reset restores CLI defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-model-"));
		try {
			const store = new AcpConfigStore(dir);
			store.save({ ...store.find("codex")!, modelSettings: custom });
			const { modelSettings: _, ...agent } = store.find("codex")!;
			store.save({ ...agent, enabled: false, env: { KEEP: "1" } });
			const reloaded = new AcpConfigStore(dir);
			expect(reloaded.find("codex")?.modelSettings).toEqual(validateAcpModelSettings("codex", custom));
			expect(reloaded.find("codex")?.enabled).toBe(false);
			reloaded.remove("codex");
			expect(reloaded.find("codex")?.modelSettings).toBeUndefined();
			writeFileSync(join(dir, "acp-agents.json"), JSON.stringify({ builtins: [{ id: "codex", enabled: false, modelSettings: { mode: "broken" } }], custom: [] }));
			expect(new AcpConfigStore(dir).find("codex")?.enabled).toBe(false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
