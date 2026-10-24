import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPreferencesStore, sanitizePreferences } from "../../src/main/app-preferences";

test("close behavior upgrades old preferences and survives restart", () => {
	const dir = mkdtempSync(join(tmpdir(), "neko-close-behavior-"));
	try {
		writeFileSync(join(dir, "app-preferences.json"), JSON.stringify({ notifyOnTaskFinish: false }));
		const store = new AppPreferencesStore(dir);
		expect(store.get().closeBehavior).toBe("tray");
		store.update({ closeBehavior: "tray" });
		expect(new AppPreferencesStore(dir).get()).toMatchObject({ closeBehavior: "tray", notifyOnTaskFinish: false });
		store.update({ closeBehavior: "quit" });
		expect(new AppPreferencesStore(dir).get().closeBehavior).toBe("quit");
		writeFileSync(join(dir, "app-preferences.json"), JSON.stringify({ closeBehavior: "invalid" }));
		expect(new AppPreferencesStore(dir).get().closeBehavior).toBe("tray");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("IPC rejects invalid close behaviors and failed saves do not change live preferences", () => {
	for (const closeBehavior of [true, false, "hide", null, 1, {}, []]) expect(sanitizePreferences({ closeBehavior })).toEqual({});
	const dir = mkdtempSync(join(tmpdir(), "neko-close-save-"));
	try {
		const store = new AppPreferencesStore(dir);
		mkdirSync(join(dir, "app-preferences.json.tmp"));
		expect(() => store.update({ closeBehavior: "quit" })).toThrow();
		expect(store.get().closeBehavior).toBe("tray");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
