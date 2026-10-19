import { describe, expect, test } from "bun:test";
import { automaticDisplayScale, initialWindowSize, isUiScalePercent, resolveDisplayScale } from "../../src/shared/display-scale";
import { sanitizePreferences, AppPreferencesStore } from "../../src/main/app-preferences";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("display adaptation", () => {
	test("adapts high resolution without doubling OS DPI scaling", () => {
		expect(automaticDisplayScale({ width: 2560, height: 1440 })).toBeCloseTo(4 / 3);
		expect(automaticDisplayScale({ width: 3840, height: 2160 })).toBe(2);
		// 4K at 200% OS scaling is reported as 1920 x 1080 DIPs.
		expect(automaticDisplayScale({ width: 1920, height: 1080 })).toBe(1);
		expect(automaticDisplayScale({ width: 3440, height: 1440 })).toBeCloseTo(4 / 3);
		expect(automaticDisplayScale({ width: 1440, height: 2560 })).toBeCloseTo(4 / 3);
	});
	test("fits small windows and recomputes when moving to a smaller display", () => {
		const large = { width: 3840, height: 2160 };
		expect(resolveDisplayScale(large, { width: 3840, height: 2100 }, null)).toBe(2);
		expect(resolveDisplayScale(large, { width: 1000, height: 640 }, null)).toBe(1);
		expect(resolveDisplayScale(large, { width: 800, height: 520 }, null)).toBe(0.8);
		expect(resolveDisplayScale({ width: 1920, height: 1080 }, large, null)).toBe(1);
		expect(resolveDisplayScale(large, large, 125)).toBe(1.25);
		expect(resolveDisplayScale(large, large, Number.NaN)).toBe(2);
	});
	test("initial and minimum window bounds fit small work areas", () => {
		for (const area of [{ width: 1024, height: 600 }, { width: 800, height: 480 }]) {
			const bounds = initialWindowSize(area, area);
			expect(bounds.width).toBeLessThanOrEqual(area.width);
			expect(bounds.height).toBeLessThanOrEqual(area.height);
			expect(bounds.minWidth).toBeLessThanOrEqual(bounds.width);
			expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height);
		}
	});
	test("rejects invalid IPC preferences", () => {
		for (const value of [undefined, "150", 0, 74, 201, Infinity, NaN]) {
			expect(isUiScalePercent(value)).toBe(false);
			expect(sanitizePreferences({ uiScalePercent: value })).toEqual({});
		}
		expect(sanitizePreferences({ uiScalePercent: null })).toEqual({ uiScalePercent: null });
	});
	test("persists manual zoom and restores automatic mode", () => {
		const dir = mkdtempSync(join(tmpdir(), "neko-display-scale-"));
		try {
			const store = new AppPreferencesStore(dir);
			expect(store.get().uiScalePercent).toBeNull();
			store.update({ uiScalePercent: 150 });
			expect(new AppPreferencesStore(dir).get().uiScalePercent).toBe(150);
			store.update({ uiScalePercent: null });
			expect(new AppPreferencesStore(dir).get().uiScalePercent).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
