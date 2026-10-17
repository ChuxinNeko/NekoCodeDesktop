import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	packageSource,
	projectRunsCode,
	resolvePluginTrust,
	trustProject,
	withEnabledPackages,
} from "../../src/main/plugin-resources";
import { pi } from "../../src/main/pi";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "neko-plugin-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("packageSource reads both spellings of a package entry", () => {
	expect(packageSource("npm:a")).toBe("npm:a");
	expect(packageSource({ source: "git:b", extensions: [] })).toBe("git:b");
});

describe("withEnabledPackages", () => {
	test("legacy .pi project settings remain usable and an explicit .nekocode directory takes precedence", async () => {
		const { SettingsManager, DefaultPackageManager, getProjectConfigDir } = await pi();
		const cwd = temp();
		const agentDir = temp();
		const legacy = join(cwd, ".pi");
		mkdirSync(legacy);
		writeFileSync(join(legacy, "settings.json"), JSON.stringify({ packages: ["npm:legacy"] }));
		const settings = SettingsManager.create(cwd, agentDir);
		expect(getProjectConfigDir(cwd)).toBe(legacy);
		expect(settings.getProjectSettings().packages).toEqual(["npm:legacy"]);
		expect(new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }).listConfiguredPackages().map((entry) => entry.source)).toEqual(["npm:legacy"]);
		const branded = join(cwd, ".nekocode");
		mkdirSync(branded);
		writeFileSync(join(branded, "settings.json"), JSON.stringify({ packages: ["npm:branded"] }));
		expect(getProjectConfigDir(cwd)).toBe(branded);
		expect(SettingsManager.create(cwd, agentDir).getProjectSettings().packages).toEqual(["npm:branded"]);
	});

	test("hides disabled packages from reads, leaving the files alone", async () => {
		const { SettingsManager } = await pi();
		const cwd = temp();
		const agentDir = temp();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:on", "npm:off"] }));
		mkdirSync(join(cwd, ".nekocode"));
		writeFileSync(join(cwd, ".nekocode", "settings.json"), JSON.stringify({ packages: [{ source: "npm:proj" }] }));
		const settings = withEnabledPackages(SettingsManager.create(cwd, agentDir), (source) => source !== "npm:off");
		expect(settings.getGlobalSettings().packages).toEqual(["npm:on"]);
		expect(settings.getProjectSettings().packages).toEqual([{ source: "npm:proj" }]);

		const { DefaultPackageManager } = await pi();
		const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
		expect(manager.listConfiguredPackages().map((entry) => entry.source).sort()).toEqual(["npm:on", "npm:proj"]);
		// A fresh manager over the same files still sees everything.
		const unfiltered = SettingsManager.create(cwd, agentDir);
		expect(unfiltered.getGlobalSettings().packages).toEqual(["npm:on", "npm:off"]);
	});
});

describe("project trust", () => {
	test("only code makes a project ask", () => {
		const config = temp();
		expect(projectRunsCode(config)).toBe(false);
		writeFileSync(join(config, "settings.json"), JSON.stringify({ packages: [] }));
		expect(projectRunsCode(config)).toBe(false);
		mkdirSync(join(config, "skills"));
		expect(projectRunsCode(config)).toBe(false);
		writeFileSync(join(config, "settings.json"), JSON.stringify({ packages: ["npm:x"] }));
		expect(projectRunsCode(config)).toBe(true);
		writeFileSync(join(config, "settings.json"), "{}");
		mkdirSync(join(config, "extensions"));
		expect(projectRunsCode(config)).toBe(true);
	});

	function codeProject(): string {
		const cwd = temp();
		mkdirSync(join(cwd, ".nekocode", "extensions"), { recursive: true });
		return cwd;
	}

	test("a project without code is trusted without asking", async () => {
		let asked = false;
		const trusted = await resolvePluginTrust(temp(), temp(), async () => {
			asked = true;
			return "never";
		});
		expect(trusted).toBe(true);
		expect(asked).toBe(false);
	});

	test("nobody to ask means untrusted until decided", async () => {
		expect(await resolvePluginTrust(codeProject(), temp())).toBe(false);
	});

	test("always and never are saved in pi's trust store; once is not", async () => {
		const agentDir = temp();
		const always = codeProject();
		expect(await resolvePluginTrust(always, agentDir, async () => "always")).toBe(true);
		expect(await resolvePluginTrust(always, agentDir)).toBe(true);

		const never = codeProject();
		expect(await resolvePluginTrust(never, agentDir, async () => "never")).toBe(false);
		expect(await resolvePluginTrust(never, agentDir, async () => "always")).toBe(false);

		const once = codeProject();
		expect(await resolvePluginTrust(once, agentDir, async () => "once")).toBe(true);
		// Remembered for the life of the app, not written down.
		expect(await resolvePluginTrust(once, agentDir)).toBe(true);
		const { ProjectTrustStore } = await pi();
		expect(new ProjectTrustStore(agentDir).get(once)).toBeNull();
	});

	test("installing into a project trusts it", async () => {
		const agentDir = temp();
		const cwd = codeProject();
		await trustProject(cwd, agentDir);
		expect(await resolvePluginTrust(cwd, agentDir)).toBe(true);
	});
});
