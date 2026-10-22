import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPreferencesStore, sanitizePreferences } from "../../src/main/app-preferences";
import { configureAgentRetry, currentAgentRetrySettings } from "../../src/main/agent-retry";
import { isAutoRetryCount } from "../../src/shared/preferences";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent/settings";

afterEach(() => configureAgentRetry(() => undefined));

describe("automatic retry preferences", () => {
	test("accepts only bounded integer counts over IPC", () => {
		for (const value of [-1, 11, 1.5, Infinity, NaN, "3", null, undefined, true]) {
			expect(isAutoRetryCount(value)).toBe(false);
			expect(sanitizePreferences({ autoRetryCount: value })).toEqual({});
		}
		for (const value of [0, 3, 10]) expect(sanitizePreferences({ autoRetryCount: value })).toEqual({ autoRetryCount: value });
	});

	test("upgrades old settings, persists the count, and rejects corrupt saved values", () => {
		const dir = mkdtempSync(join(tmpdir(), "neko-retry-"));
		try {
			writeFileSync(join(dir, "app-preferences.json"), JSON.stringify({ notifyOnTaskFinish: false }));
			const store = new AppPreferencesStore(dir);
			expect(store.get().autoRetryCount).toBe(5);
			store.update({ autoRetryCount: 0 });
			expect(new AppPreferencesStore(dir).get()).toMatchObject({ autoRetryCount: 0, notifyOnTaskFinish: false });
			store.update({ autoRetryCount: 10 });
			expect(new AppPreferencesStore(dir).get().autoRetryCount).toBe(10);
			writeFileSync(join(dir, "app-preferences.json"), JSON.stringify({ autoRetryCount: -5 }));
			expect(new AppPreferencesStore(dir).get().autoRetryCount).toBe(5);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("NekoLocal reads updated retry settings and disables at zero", () => {
		let count = 2;
		configureAgentRetry(() => count);
		expect(currentAgentRetrySettings()).toEqual({ retry: { enabled: true, maxRetries: 2 } });
		const settings = SettingsManager.inMemory({ retry: { provider: { maxRetries: 1 }, baseDelayMs: 250 } });
		settings.applyOverrides(currentAgentRetrySettings());
		expect(settings.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 2, baseDelayMs: 250 });
		expect(settings.getProviderRetrySettings().maxRetries).toBe(1);
		count = 0;
		expect(currentAgentRetrySettings()).toEqual({ retry: { enabled: false, maxRetries: 0 } });
		settings.applyOverrides(currentAgentRetrySettings());
		expect(settings.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 0 });
	});

	test("NekoLocal classifies both reported tool protocol failures as recoverable", () => {
		const message = (errorMessage: string) => ({ stopReason: "error", errorMessage }) as AssistantMessage;
		expect(isRetryableAssistantError(message("basispoints_tool_arguments_stalled: Tool arguments stopped making progress"))).toBe(true);
		expect(isRetryableAssistantError(message("basispoints_protocol_error: correction changed an operation; no tool was executed"))).toBe(true);
		expect(isRetryableAssistantError(message("basispoints_protocol_error: operation outcome is unknown"))).toBe(false);
	});
});
