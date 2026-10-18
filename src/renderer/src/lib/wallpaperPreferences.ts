import type { WallpaperFit, WallpaperSource } from "../../../shared/wallpaper";

export interface WallpaperPreferences {
	source: WallpaperSource;
	imageId: string | null;
	engineId: string | null;
	/** Remembered title so the settings row can name the choice before the library is scanned again. */
	engineTitle: string | null;
	fit: WallpaperFit;
	/** 0–100. How strongly the wallpaper shows, and how far the content surface gives way to it. */
	strength: number;
	blur: number;
	/** 0–80. A black veil over the wallpaper so text stays readable. */
	dim: number;
	muted: boolean;
}

export const DEFAULT_WALLPAPER_PREFERENCES: WallpaperPreferences = {
	source: "none",
	imageId: null,
	engineId: null,
	engineTitle: null,
	fit: "cover",
	strength: 70,
	blur: 0,
	dim: 32,
	muted: true,
};

const STORAGE_KEY = "nekocode:wallpaper";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function text(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

export function normalizeWallpaperPreferences(value: unknown): WallpaperPreferences {
	const prefs = isRecord(value) ? value : {};
	const defaults = DEFAULT_WALLPAPER_PREFERENCES;
	const source = prefs.source === "image" || prefs.source === "engine" ? prefs.source : "none";
	const fit = prefs.fit === "contain" || prefs.fit === "stretch" ? prefs.fit : "cover";
	return {
		source,
		imageId: text(prefs.imageId, 180),
		engineId: text(prefs.engineId, 180),
		engineTitle: text(prefs.engineTitle, 200),
		fit,
		strength: clamp(prefs.strength, 0, 100, defaults.strength),
		blur: clamp(prefs.blur, 0, 40, defaults.blur),
		dim: clamp(prefs.dim, 0, 80, defaults.dim),
		muted: typeof prefs.muted === "boolean" ? prefs.muted : defaults.muted,
	};
}

export function readWallpaperPreferences(): WallpaperPreferences {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return normalizeWallpaperPreferences(raw ? JSON.parse(raw) : null);
	} catch {
		return DEFAULT_WALLPAPER_PREFERENCES;
	}
}

export function writeWallpaperPreferences(prefs: WallpaperPreferences): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// The in-memory copy still applies for this session.
	}
}
