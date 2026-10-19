import type { ThemeMode, ThemeVariant } from "../theme/theme.logic";

/**
 * Wallpaper adaptation follows dsh-wallpaper-engine's approach (MIT):
 * scheme colour → 64px dominant-colour sample → theme; theme-base glass floors
 * protect text independently of the artwork. No per-letter inversion.
 * https://github.com/elysia395/dsh-wallpaper-engine
 * Copyright (c) 2026 elysia395. MIT license reproduced in
 * docs/wallpaper-readability.md.
 *
 * Our automatic theme is transient: it never overwrites the saved theme pack
 * or mode, and a manual theme choice yields until a different wallpaper.
 */
export type Rgb = readonly [number, number, number];
export const WALLPAPER_SAMPLE_SIZE = 64;
export const WALLPAPER_LIGHT_THRESHOLD = 0.4;
export const WALLPAPER_READABILITY_FLOOR = { light: 0.45, dark: 0.59 } as const;
const BASE_GLASS_ALPHA = 0.55;
const BASE_PANEL_ALPHA = 0.275;

export function parseWallpaperColor(value: string | null | undefined): Rgb | null {
	if (!value) return null;
	const hex = /^#([a-f\d]{6}|[a-f\d]{3})$/i.exec(value.trim());
	if (hex) {
		const expanded = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
		return [0, 2, 4].map((i) => parseInt(expanded.slice(i, i + 2), 16)) as unknown as Rgb;
	}
	const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*[\d.]+)?\s*\)$/i.exec(value.trim());
	const triple = rgb ? rgb.slice(1, 4).map(Number) : value.trim().split(/\s+/).map(Number);
	if (triple.length !== 3 || triple.some((n) => !Number.isFinite(n) || n < 0)) return null;
	const scale = !rgb && triple.every((n) => n <= 1) ? 255 : 1;
	return triple.map((n) => Math.min(255, n * scale)) as unknown as Rgb;
}

export function wallpaperLuminance(rgb: Rgb): number {
	const linear = rgb.map((c) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function wallpaperContrast(a: Rgb, b: Rgb): number {
	const x = wallpaperLuminance(a), y = wallpaperLuminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function wallpaperColorTheme(rgb: Rgb | null): ThemeVariant | null {
	return rgb ? wallpaperLuminance(rgb) > WALLPAPER_LIGHT_THRESHOLD ? "light" : "dark" : null;
}

/** Wallpaper Engine's unfilled author schemecolor is exactly black. */
export function wallpaperSchemeTheme(value: string | null | undefined): ThemeVariant | null {
	const rgb = parseWallpaperColor(value);
	return rgb?.some((n) => n !== 0) ? wallpaperColorTheme(rgb) : null;
}

export function dominantWallpaperColor(pixels: ArrayLike<number>): Rgb | null {
	const bins = new Uint32Array(4096);
	let best = -1, count = 0;
	for (let i = 0; i + 3 < pixels.length; i += 4) {
		if (pixels[i + 3] < 128) continue;
		const key = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4);
		const next = ++bins[key];
		if (next > count || (next === count && key < best)) { best = key; count = next; }
	}
	return best < 0 ? null : [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8];
}

export function resolveWallpaperImageTheme(preview: ThemeVariant | null, frame: ThemeVariant | null): ThemeVariant | null {
	if (!preview) return frame;
	if (!frame) return preview;
	return preview === "light" && frame === "light" ? "light" : "dark";
}

export function sampleWallpaperFrame(source: CanvasImageSource): Rgb | null {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = WALLPAPER_SAMPLE_SIZE;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return null;
		context.drawImage(source, 0, 0, WALLPAPER_SAMPLE_SIZE, WALLPAPER_SAMPLE_SIZE);
		return dominantWallpaperColor(context.getImageData(0, 0, WALLPAPER_SAMPLE_SIZE, WALLPAPER_SAMPLE_SIZE).data);
	} catch {
		// A missing frame, tainted canvas or unsupported renderer keeps the old theme.
		return null;
	}
}

export function sampleWallpaperImage(url: string, signal: AbortSignal): Promise<Rgb | null> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve(null);
		const image = new Image();
		const done = (rgb: Rgb | null) => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			image.onload = image.onerror = null;
			resolve(rgb);
		};
		const abort = () => { done(null); image.src = ""; };
		const timeout = setTimeout(abort, 8000);
		signal.addEventListener("abort", abort, { once: true });
		image.crossOrigin = "anonymous";
		image.onload = () => done(sampleWallpaperFrame(image));
		image.onerror = () => done(null);
		image.src = url;
	});
}

export interface WallpaperThemeState {
	key: string | null;
	follow: boolean;
	variant: ThemeVariant | null;
	yielded: boolean;
}
export const EMPTY_WALLPAPER_THEME: WallpaperThemeState = { key: null, follow: false, variant: null, yielded: false };

export function updateWallpaperTheme(
	state: WallpaperThemeState, key: string | null, follow: boolean, variant: ThemeVariant | null,
): WallpaperThemeState {
	if (!key) return EMPTY_WALLPAPER_THEME;
	const yielded = state.key === key && state.follow === follow && state.yielded;
	return { key, follow, variant: follow ? variant : null, yielded };
}

export function yieldWallpaperTheme(state: WallpaperThemeState): WallpaperThemeState {
	return state.key ? { ...state, yielded: true } : state;
}

export function resolveWallpaperTheme(mode: ThemeMode, systemDark: boolean, state: WallpaperThemeState): ThemeVariant {
	if (state.key && state.follow && !state.yielded && state.variant) return state.variant;
	return mode === "system" ? systemDark ? "dark" : "light" : mode;
}

function mix(a: Rgb, b: Rgb, weight: number): Rgb {
	return a.map((n, i) => n * weight + b[i] * (1 - weight)) as unknown as Rgb;
}
function hex(rgb: Rgb): string {
	return "#" + rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
}

/** Move toward a contrast-safe extreme, retaining the user's hue when possible. */
function ensureContrast(color: Rgb, target: Rgb, passes: (rgb: Rgb) => boolean): Rgb {
	if (passes(color)) return color;
	let lo = 0, hi = 1;
	for (let i = 0; i < 16; i++) {
		const amount = (lo + hi) / 2;
		if (passes(mix(target, color, amount))) hi = amount; else lo = amount;
	}
	// A little room for 8-bit rounding, in addition to the 4.6:1 target.
	return mix(target, color, Math.min(1, hi + 0.005)).map(Math.round) as unknown as Rgb;
}

/**
 * The most transparent text-bearing surface is the window panel, not a field.
 * Protect it too: title bar, rail, navigation, transcript and dock all share
 * this floor without adding blur to the navigation. Opaque editors/syntax
 * tokens and inverse button text are deliberately not rewritten.
 */
export function buildWallpaperReadability(variables: Record<string, string>, variant: ThemeVariant): Record<string, string> {
	const dark = variant === "dark";
	const floor = WALLPAPER_READABILITY_FLOOR[variant];
	const panelAlpha = floor + BASE_PANEL_ALPHA * (1 - floor);
	const glassAlpha = floor + BASE_GLASS_ALPHA * (1 - floor);
	const paper: Rgb = dark ? [0, 0, 0] : [255, 255, 255];
	const backdrop: Rgb = dark ? [255, 255, 255] : [0, 0, 0];
	const ink: Rgb = dark ? [255, 255, 255] : [0, 0, 0];
	const tint = ensureContrast(parseWallpaperColor(variables["--popover"]) ?? paper, paper,
		(rgb) => wallpaperContrast(ink, mix(rgb, backdrop, panelAlpha)) >= 4.6);
	const worstBackground = mix(tint, backdrop, panelAlpha);
	// Theme secondary/tertiary roles are usually rgba(primary, opacity).
	// Flatten that opacity against the tint before enforcing contrast, otherwise
	// discarding alpha would accidentally make every role identical to primary.
	const roleColor = (name: string, fallback: Rgb): Rgb => {
		const value = variables[name];
		const color = parseWallpaperColor(value) ?? fallback;
		const opacity = value?.match(/^rgba\([^)]*[,/]\s*([\d.]+)\s*\)$/i)?.[1];
		return opacity === undefined ? color : mix(color, tint, Math.min(1, Math.max(0, Number(opacity))));
	};
	const adjustInk = (name: string, fallback: Rgb, targetContrast: number) =>
		hex(ensureContrast(roleColor(name, fallback), ink, (rgb) =>
			(dark ? wallpaperLuminance(rgb) > wallpaperLuminance(worstBackground) : wallpaperLuminance(rgb) < wallpaperLuminance(worstBackground)) &&
			wallpaperContrast(rgb, worstBackground) >= targetContrast));
	const primary = adjustInk("--foreground", ink, 6);
	const secondary = adjustInk("--muted-foreground", dark ? [218, 218, 220] : [40, 42, 46], 4.8);
	const tertiary = adjustInk("--color-text-foreground-tertiary", dark ? [204, 204, 208] : [70, 73, 79], 4.6);
	const result: Record<string, string> = {
		"--popover": hex(tint),
		"--color-token-dropdown-background": hex(tint),
		"--app-composer-picker-surface": "color-mix(in srgb, var(--composer-glass-surface) var(--composer-glass-opacity), transparent)",
		"--composer-glass-surface": hex(tint),
		"--composer-glass-opacity": `${glassAlpha * 100}%`,
		"--composer-glass-stacked-opacity": `${panelAlpha * 100}%`,
		"--wallpaper-readability-floor": String(floor),
	};
	for (const name of ["--foreground", "--card-foreground", "--popover-foreground", "--sidebar-foreground",
		"--sidebar-accent-foreground", "--color-text-foreground", "--color-icon-primary",
		"--color-token-foreground", "--color-token-input-foreground", "--color-token-list-active-selection-foreground"]) result[name] = primary;
	for (const name of ["--muted-foreground", "--color-text-foreground-secondary", "--color-icon-secondary",
		"--color-token-description-foreground"]) result[name] = secondary;
	for (const name of ["--color-text-foreground-tertiary", "--color-icon-tertiary",
		"--color-token-input-placeholder-foreground", "--color-token-disabled-foreground"]) result[name] = tertiary;
	return result;
}