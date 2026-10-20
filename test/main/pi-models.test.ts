import { expect, test } from "bun:test";
import { piModels } from "../../src/main/pi";

test("model/default initialization shares one promise and the SDK's original module identities", async () => {
	const first = piModels();
	expect(piModels()).toBe(first);
	const [models, runtimeEntry, settingsEntry] = await Promise.all([
		first,
		import("@earendil-works/pi-coding-agent/model-runtime"),
		import("@earendil-works/pi-coding-agent/settings"),
	]);
	expect(models.ModelRuntime).toBe(runtimeEntry.ModelRuntime);
	expect(models.SettingsManager).toBe(settingsEntry.SettingsManager);
	expect(models).not.toHaveProperty("InteractiveMode");
	expect(models).not.toHaveProperty("copyToClipboard");
	expect(models).not.toHaveProperty("main");
});

test("starting a full SDK session later reuses the same runtime and settings classes", async () => {
	const [models, full] = await Promise.all([piModels(), import("@earendil-works/pi-coding-agent")]);
	expect(models.ModelRuntime).toBe(full.ModelRuntime);
	expect(models.SettingsManager).toBe(full.SettingsManager);
});
