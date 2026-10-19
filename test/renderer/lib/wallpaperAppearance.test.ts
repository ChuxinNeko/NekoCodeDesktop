import { describe, expect, test } from "bun:test";
import {
	EMPTY_WALLPAPER_THEME, WALLPAPER_READABILITY_FLOOR, WALLPAPER_SAMPLE_SIZE,
	buildWallpaperReadability, dominantWallpaperColor, parseWallpaperColor,
	resolveWallpaperImageTheme, resolveWallpaperTheme, updateWallpaperTheme,
	wallpaperColorTheme, wallpaperContrast, wallpaperLuminance, wallpaperSchemeTheme,
	yieldWallpaperTheme, type Rgb,
} from "../../../src/renderer/src/lib/wallpaperAppearance";
import { DEFAULT_THEME_STATE, buildThemeCssVariables, resolveThemePack, type ThemeVariant } from "../../../src/renderer/src/theme/theme.logic";
import { DEFAULT_WALLPAPER_PREFERENCES, normalizeWallpaperPreferences } from "../../../src/renderer/src/lib/wallpaperPreferences";

describe("wallpaper scheme and dominant-colour decisions", () => {
	test("parses author colour formats, rejects missing/invalid values", () => {
		expect(parseWallpaperColor("#abc")).toEqual([170, 187, 204]);
		expect(parseWallpaperColor("rgb(12, 34, 56)")).toEqual([12, 34, 56]);
		expect(parseWallpaperColor("0.2 0.4 0.6")).toEqual([51, 102, 153]);
		for (const input of ["", "bad", "NaN 0 1", "-1 0 1", "rgb(1,2)", null]) expect(parseWallpaperColor(input)).toBeNull();
	});
	test("uses WCAG luminance and the reference 0.40 cutoff", () => {
		expect(WALLPAPER_SAMPLE_SIZE).toBe(64);
		expect(wallpaperLuminance([0, 0, 0])).toBe(0);
		expect(wallpaperLuminance([255, 255, 255])).toBe(1);
		expect(wallpaperLuminance([128, 128, 128])).toBeCloseTo(0.21586, 4);
		expect(wallpaperColorTheme([168, 168, 168])).toBe("dark");
		expect(wallpaperColorTheme([170, 170, 170])).toBe("light");
		expect(wallpaperColorTheme(null)).toBeNull();
	});
	test("author pure black means unfilled, not an authoritative dark verdict", () => {
		expect(wallpaperSchemeTheme("0 0 0")).toBeNull();
		expect(wallpaperSchemeTheme("#000000")).toBeNull();
		expect(wallpaperSchemeTheme("#ffffff")).toBe("light");
		expect(wallpaperSchemeTheme("#010101")).toBe("dark");
	});
	test("takes the modal 4-bit bucket, ignores transparency, and breaks ties deterministically", () => {
		const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], invisible = [255, 255, 255, 127];
		expect(dominantWallpaperColor([...red, ...red, ...blue, ...invisible, ...invisible])).toEqual([248, 8, 8]);
		expect(dominantWallpaperColor([...red, ...blue])).toEqual([8, 8, 248]);
		expect(dominantWallpaperColor([...blue, ...red])).toEqual([8, 8, 248]);
		expect(dominantWallpaperColor(invisible)).toBeNull();
		expect(dominantWallpaperColor([])).toBeNull();
	});
	test("preview and real frame agree on light; disagreement favours dark in either arrival order", () => {
		expect(resolveWallpaperImageTheme("light", "light")).toBe("light");
		expect(resolveWallpaperImageTheme("light", "dark")).toBe("dark");
		expect(resolveWallpaperImageTheme("dark", "light")).toBe("dark");
		expect(resolveWallpaperImageTheme(null, "light")).toBe("light");
		expect(resolveWallpaperImageTheme("dark", null)).toBe("dark");
		expect(resolveWallpaperImageTheme(null, null)).toBeNull();
	});
});

describe("temporary wallpaper ownership", () => {
	test("follow is explicitly opt-in and safely migrates old settings", () => {
		expect(normalizeWallpaperPreferences(null)).toEqual(DEFAULT_WALLPAPER_PREFERENCES);
		expect(normalizeWallpaperPreferences({ source: "image" }).themeFollow).toBe(false);
		expect(normalizeWallpaperPreferences({ themeFollow: "true" }).themeFollow).toBe(false);
		expect(normalizeWallpaperPreferences({ themeFollow: true }).themeFollow).toBe(true);
	});
	test("automatic theme does not need to change the saved mode", () => {
		const state = updateWallpaperTheme(EMPTY_WALLPAPER_THEME, "image:a", true, "dark");
		expect(resolveWallpaperTheme("light", false, state)).toBe("dark");
		expect(resolveWallpaperTheme("system", false, state)).toBe("dark");
	});
	test("a manual theme choice keeps control across repeated samples and same-wallpaper updates", () => {
		let state = updateWallpaperTheme(EMPTY_WALLPAPER_THEME, "image:a", true, "dark");
		state = yieldWallpaperTheme(state);
		state = updateWallpaperTheme(state, "image:a", true, "dark");
		expect(resolveWallpaperTheme("light", false, state)).toBe("light");
		state = updateWallpaperTheme(state, "image:b", true, "dark");
		expect(resolveWallpaperTheme("light", false, state)).toBe("dark");
	});
	test("even a manual choice before sampling yields; a deliberate re-enable starts a new evaluation", () => {
		let state = yieldWallpaperTheme(updateWallpaperTheme(EMPTY_WALLPAPER_THEME, "image:a", true, null));
		state = updateWallpaperTheme(state, "image:a", true, "dark");
		expect(resolveWallpaperTheme("light", false, state)).toBe("light");
		state = updateWallpaperTheme(state, "image:a", false, null);
		state = updateWallpaperTheme(state, "image:a", true, "dark");
		expect(resolveWallpaperTheme("light", false, state)).toBe("dark");
	});
	test("off, removal and absent samples fall back to the original mode/system preference", () => {
		for (const state of [
			EMPTY_WALLPAPER_THEME,
			updateWallpaperTheme(EMPTY_WALLPAPER_THEME, "image:a", false, "dark"),
			updateWallpaperTheme(EMPTY_WALLPAPER_THEME, "image:a", true, null),
			updateWallpaperTheme(updateWallpaperTheme(EMPTY_WALLPAPER_THEME, "image:a", true, "dark"), null, true, null),
		]) {
			expect(resolveWallpaperTheme("light", true, state)).toBe("light");
			expect(resolveWallpaperTheme("system", true, state)).toBe("dark");
			expect(resolveWallpaperTheme("system", false, state)).toBe("light");
		}
	});
});

describe("contrast-protected glass and semantic text", () => {
	const colors = ["#000000", "#ffffff", "#777777", "#f0b4d8", "#194e93", "#ff0000", "#00ff00", "#0000ff"];
	const composite = (color: Rgb, back: number, alpha: number) =>
		color.map((c) => c * alpha + back * (1 - alpha)) as unknown as Rgb;
	for (const variant of ["light", "dark"] as ThemeVariant[]) {
		test(`${variant}: all ordinary text roles clear 4.5:1 on black/white wallpaper across custom tints and ink`, () => {
			const base = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, variant), variant).variables;
			for (const tint of colors) for (const customInk of colors) {
				const safe = buildWallpaperReadability({
					...base, "--popover": tint, "--foreground": customInk,
					"--muted-foreground": customInk, "--color-text-foreground-tertiary": customInk,
				}, variant);
				const surface = parseWallpaperColor(safe["--composer-glass-surface"])!;
				for (const alpha of [
					parseFloat(safe["--composer-glass-stacked-opacity"]) / 100,
					parseFloat(safe["--composer-glass-opacity"]) / 100,
					0.72, // Existing control hover material.
					1, // Native option popup.
				]) for (const backdrop of [0, 255]) {
					const bg = composite(surface, backdrop, alpha);
					for (const token of ["--foreground", "--muted-foreground", "--color-text-foreground-tertiary"]) {
						expect(wallpaperContrast(parseWallpaperColor(safe[token])!, bg)).toBeGreaterThanOrEqual(4.5);
					}
				}
				expect(Number(safe["--wallpaper-readability-floor"])).toBe(WALLPAPER_READABILITY_FLOOR[variant]);
				expect(safe["--vscode-terminal-ansiRed"]).toBeUndefined();
				expect(safe["--destructive"]).toBeUndefined(); // Semantic error and syntax colours are not repainted.
			}
		});
	}
	test("does not mutate the base theme/palette or inject any navigation blur", () => {
		const variables = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, "light"), "light").variables;
		const before = JSON.stringify(variables);
		const safe = buildWallpaperReadability(variables, "light");
		expect(JSON.stringify(variables)).toBe(before);
		expect(Object.keys(safe).some((key) => key.includes("filter"))).toBe(false);
		expect(safe["--composer-glass-opacity"]).not.toBe("55%");
	});
	test("rgba secondary/tertiary roles keep their hierarchy instead of turning into primary", () => {
		for (const variant of ["light", "dark"] as ThemeVariant[]) {
			const variables = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, variant), variant).variables;
			const safe = buildWallpaperReadability(variables, variant);
			const primary = wallpaperLuminance(parseWallpaperColor(safe["--foreground"])!);
			const secondary = wallpaperLuminance(parseWallpaperColor(safe["--muted-foreground"])!);
			const tertiary = wallpaperLuminance(parseWallpaperColor(safe["--color-text-foreground-tertiary"])!);
			expect(variant === "dark" ? primary > secondary && secondary > tertiary : primary < secondary && secondary < tertiary).toBe(true);
		}
	});
});