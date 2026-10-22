import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpNativeConfig } from "../../../src/main/acp/native-config";
import { AcpConfigStore } from "../../../src/main/acp/config-store";
import { agentLaunch } from "../../../src/main/acp/launch";
import { parseProviderConfig, profileFromPreset, updateProviderFields } from "../../../src/shared/acp-providers";
import type { AcpProviderProfile } from "../../../src/shared/acp";
import { StdioTransport } from "../../../src/main/acp/stdio-transport";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "neko-acp-native-"));
	const home = join(root, "home");
	const data = join(root, "app");
	const native = new AcpNativeConfig({ homeDir: home, env: {} });
	const store = new AcpConfigStore(data, native);
	const path = (agent: string, file: string) => join(home, agent === "claude" ? ".claude" : ".codex", file);
	const seed = (agent: string, file: string, content: string) => {
		const target = path(agent, file);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content);
	};
	const add = (id: string, profile: AcpProviderProfile, active = true) => {
		const agent = store.find(id)!;
		const state = agent.providerState!;
		return store.save({ ...agent, providerState: { activeId: active ? profile.id : state.activeId, profiles: [...state.profiles.filter((entry) => entry.id !== profile.id), profile] } });
	};
	return { root, home, data, native, store, path, seed, add, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function custom(agent: string): AcpProviderProfile {
	return { ...updateProviderFields(agent, profileFromPreset(agent), { baseUrl: "https://gateway.test", model: "chosen-model", apiKey: "chosen-secret", apiKeyField: "ANTHROPIC_AUTH_TOKEN", haiku: "small", sonnet: "middle", opus: "large" }), id: "custom", name: "Test" };
}

describe("ACP native client configuration", () => {
	test("imports real Claude settings and writes the selected provider while preserving user settings", () => {
		const f = fixture();
		try {
			const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old.test", ANTHROPIC_API_KEY: "old", CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "old", KEEP: "yes", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }, apiKeyHelper: "old-helper", model: "old-model", hooks: { SessionStart: [] }, permissions: { defaultMode: "default" } });
			f.seed("claude", "settings.json", original);
			const imported = f.store.find("claude")!.providerState!.profiles[0];
			expect(imported.apiKey).toBe("old");
			expect(parseProviderConfig("claude", imported.config).model).toBe("old-model");
			f.add("claude", custom("claude"));
			const settings = JSON.parse(readFileSync(f.path("claude", "settings.json"), "utf8"));
			expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://gateway.test", ANTHROPIC_AUTH_TOKEN: "chosen-secret", ANTHROPIC_MODEL: "chosen-model", ANTHROPIC_DEFAULT_HAIKU_MODEL: "small", ANTHROPIC_DEFAULT_OPUS_MODEL: "large", KEEP: "yes", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" });
			expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(settings.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
			expect(settings.env.AWS_REGION).toBeUndefined();
			expect(settings.apiKeyHelper).toBeUndefined();
			expect(settings.model).toBeUndefined();
			expect(settings.hooks).toEqual({ SessionStart: [] });
			expect(settings.permissions).toEqual({ defaultMode: "default" });
			expect(readFileSync(`${f.path("claude", "settings.json")}.nekocode.bak`, "utf8")).toBe(original);
			const agent = f.store.find("claude")!;
			f.store.save({ ...agent, providerState: { ...agent.providerState!, activeId: imported.id } });
			expect(JSON.parse(readFileSync(f.path("claude", "settings.json"), "utf8"))).toEqual(JSON.parse(original));
		} finally { f.dispose(); }
	});

	test("Codex uses a native bearer route, preserves OAuth credentials and unrelated TOML verbatim", () => {
		const f = fixture();
		try {
			const original = '# user comment\nmodel = "old-model" # old selection\n\n[features]\nkeep = true # keep this comment\n\n[mcp_servers.local]\ncommand = "node"\nargs = [\n  "server.js",\n]\n\n[projects."D:/work"]\ntrust_level = "trusted"\n';
			const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "saved-login", refresh_token: "saved-refresh" } });
			f.seed("codex", "config.toml", original);
			f.seed("codex", "auth.json", auth);
			f.add("codex", custom("codex"));
			const text = readFileSync(f.path("codex", "config.toml"), "utf8");
			const config = parseProviderConfig("codex", text);
			expect(config).toMatchObject({ model: "chosen-model", model_provider: "custom", model_providers: { custom: { base_url: "https://gateway.test", wire_api: "responses", experimental_bearer_token: "chosen-secret", requires_openai_auth: false } } });
			expect(text).toContain(original.slice(original.indexOf("[features]")));
			expect(text).toContain("# user comment");
			expect(readFileSync(f.path("codex", "auth.json"), "utf8")).toBe(auth);
			expect(readFileSync(`${f.path("codex", "config.toml")}.nekocode.bak`, "utf8")).toBe(original);
			f.store.syncNative("codex");
			expect(readFileSync(f.path("codex", "config.toml"), "utf8")).toBe(text);
		} finally { f.dispose(); }
	});

	test("editing inactive providers does not touch native files; editing the active provider does", () => {
		const f = fixture();
		try {
			const original = '{"env":{"ANTHROPIC_BASE_URL":"https://existing.test"},"theme":"dark"}';
			f.seed("claude", "settings.json", original);
			f.add("claude", custom("claude"), false);
			expect(readFileSync(f.path("claude", "settings.json"), "utf8")).toBe(original);
			expect(existsSync(`${f.path("claude", "settings.json")}.nekocode.bak`)).toBe(false);
			const agent = f.store.find("claude")!;
			f.store.save({ ...agent, providerState: { ...agent.providerState!, activeId: "custom" } });
			f.add("claude", updateProviderFields("claude", custom("claude"), { baseUrl: "https://edited.test", model: "edited-model" }));
			expect(JSON.parse(readFileSync(f.path("claude", "settings.json"), "utf8")).env).toMatchObject({ ANTHROPIC_BASE_URL: "https://edited.test", ANTHROPIC_MODEL: "edited-model" });
		} finally { f.dispose(); }
	});

	test("switching Codex to official removes third-party routing without destroying the saved login", () => {
		const f = fixture();
		try {
			f.seed("codex", "config.toml", '[model_providers]\n[model_providers.custom]\nname = "Old"\nbase_url = "https://old.test"\nexperimental_bearer_token = "old-key"\n');
			const auth = '{"auth_mode":"chatgpt","tokens":{"access_token":"saved"}}';
			f.seed("codex", "auth.json", auth);
			f.add("codex", { ...profileFromPreset("codex"), id: "official", name: "Official", category: "official", config: "", apiKey: "" });
			const config = parseProviderConfig("codex", readFileSync(f.path("codex", "config.toml"), "utf8"));
			expect(config.model_provider).toBeUndefined();
			expect((config.model_providers as Record<string, unknown> | undefined)?.custom).toBeUndefined();
			expect(readFileSync(f.path("codex", "auth.json"), "utf8")).toBe(auth);
		} finally { f.dispose(); }
	});

	test("failed native writes leave the previous active provider selected", () => {
		const f = fixture();
		try {
			const original = '{"env":{"ANTHROPIC_BASE_URL":"https://original.test"}}';
			f.seed("claude", "settings.json", original);
			mkdirSync(`${f.path("claude", "settings.json")}.nekocode.bak`);
			expect(() => f.add("claude", custom("claude"))).toThrow();
			expect(f.store.find("claude")!.providerState!.activeId).toBe("imported");
			expect(readFileSync(f.path("claude", "settings.json"), "utf8")).toBe(original);
		} finally { f.dispose(); }
	});

	test("migrates an older selected provider and captures the real original configuration before writing", () => {
		const f = fixture();
		try {
			const original = '{"env":{"ANTHROPIC_BASE_URL":"https://original.test","ANTHROPIC_API_KEY":"original-key"}}';
			f.seed("claude", "settings.json", original);
			const oldStore = new AcpConfigStore(f.data);
			const imported = { ...profileFromPreset("claude"), id: "imported", name: "Current", category: "current", config: "" };
			const profile = custom("claude");
			oldStore.save({ ...oldStore.find("claude")!, providerState: { activeId: profile.id, profiles: [imported, profile] } });
			f.store.syncNative("claude");
			expect(JSON.parse(readFileSync(f.path("claude", "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("https://gateway.test");
			const agent = f.store.find("claude")!;
			f.store.save({ ...agent, providerState: { ...agent.providerState!, activeId: imported.id } });
			expect(JSON.parse(readFileSync(f.path("claude", "settings.json"), "utf8"))).toEqual(JSON.parse(original));
		} finally { f.dispose(); }
	});

	test("resolves CLAUDE_CONFIG_DIR and CODEX_HOME overrides without writing the default directories", () => {
		const f = fixture();
		try {
			for (const id of ["claude", "codex"]) {
				const directory = join(f.root, `${id}-override`);
				const agent = f.store.find(id)!;
				const key = id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
				const profile = custom(id);
				f.store.save({ ...agent, env: { [key]: directory }, providerState: { activeId: profile.id, profiles: [profile] } });
				expect(existsSync(join(directory, id === "claude" ? "settings.json" : "config.toml"))).toBe(true);
				expect(existsSync(f.path(id, id === "claude" ? "settings.json" : "config.toml"))).toBe(false);
			}
		} finally { f.dispose(); }
	});

	test("invalid existing JSON/TOML is not overwritten or marked as activated", () => {
		const f = fixture();
		try {
			for (const id of ["claude", "codex"]) {
				f.add(id, custom(id));
				const agent = f.store.find(id)!;
				const filename = id === "claude" ? "settings.json" : "config.toml";
				f.seed(id, filename, "invalid = [");
				const updated = updateProviderFields(id, custom(id), { model: "changed" });
				expect(() => f.add(id, updated)).toThrow();
				expect(readFileSync(f.path(id, filename), "utf8")).toBe("invalid = [");
				expect(f.store.find(id)!.providerState).toEqual(agent.providerState);
			}
		} finally { f.dispose(); }
	});

	test("restores native files if persisting the provider pointer fails", () => {
		const f = fixture();
		try {
			const original = '{"env":{"ANTHROPIC_BASE_URL":"https://original.test"}}';
			f.seed("claude", "settings.json", original);
			mkdirSync(f.data, { recursive: true });
			mkdirSync(join(f.data, "acp-agents.json")); // Rename over a directory must fail.
			expect(() => f.add("claude", custom("claude"))).toThrow();
			expect(readFileSync(f.path("claude", "settings.json"), "utf8")).toBe(original);
			expect(f.store.find("claude")!.providerState!.activeId).toBe("imported");
		} finally { f.dispose(); }
	});

	test("native launches discard old process routing instead of shadowing the written files", () => {
		const f = fixture();
		try {
			for (const id of ["claude", "codex"]) {
				const agent = f.add(id, custom(id));
				const launch = agentLaunch({ ...agent, env: { KEEP: "yes", CODEX_CONFIG: "stale", MODEL_PROVIDER: "old", ANTHROPIC_BASE_URL: "https://stale.test", ANTHROPIC_API_KEY: "stale" } }, { nativeConfig: true, execPath: "/electron", appRoot: "/app", platform: "linux", baseEnv: { OPENAI_BASE_URL: "https://ambient.test", ANTHROPIC_AUTH_TOKEN: "ambient" }, findCli: () => "/cli", fileExists: () => true });
				expect(launch.env.KEEP).toBe("yes");
				if (id === "codex") {
					expect(launch.env.CODEX_CONFIG).toBeUndefined();
					expect(launch.unsetEnv).toContain("OPENAI_BASE_URL");
				} else {
					expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
					expect(launch.unsetEnv).toContain("ANTHROPIC_AUTH_TOKEN");
				}
			}
		} finally { f.dispose(); }
	});

	test("the stdio child really receives no cleared routing variable", async () => {
		const transport = new StdioTransport({ command: process.execPath, args: ["-e", 'process.stdout.write(JSON.stringify({route:process.env.NEKOCODE_TEST_STALE_ROUTE ?? null,keep:process.env.NEKOCODE_TEST_KEEP})+"\\n")'], env: { NEKOCODE_TEST_STALE_ROUTE: "old", NEKOCODE_TEST_KEEP: "yes" }, unsetEnv: ["NEKOCODE_TEST_STALE_ROUTE"], cwd: tmpdir(), shell: false });
		try {
			const result = await new Promise((resolve) => transport.onMessage(resolve));
			expect(result).toEqual({ route: null, keep: "yes" });
		} finally { transport.close(); }
	});
});
