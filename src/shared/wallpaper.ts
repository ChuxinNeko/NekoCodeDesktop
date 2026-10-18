/** Wallpaper Engine workshop app id. Discovery and the library scan both key off it. */
export const WALLPAPER_ENGINE_APP_ID = "431960";

export type WallpaperSource = "none" | "image" | "engine";
export type WallpaperFit = "cover" | "contain" | "stretch";
export type WeWallpaperType = "scene" | "video" | "web" | "application";

/** One Wallpaper Engine project, without any path the renderer could read from disk. */
export interface WallpaperEntry {
	id: string;
	title: string;
	type: WeWallpaperType;
	contentrating: string | null;
	schemeColor: string | null;
	hasPreview: boolean;
	/** Lowercase extension of the main file, without the dot. */
	mediaExt: string;
}

export interface WallpaperLibrary {
	/** A Wallpaper Engine install root was found, or a workshop library has projects. */
	installed: boolean;
	installDir: string | null;
	wallpapers: WallpaperEntry[];
}

export interface WallpaperUpload {
	id: string;
	name: string;
}

export type WallpaperChooseResult =
	| { ok: true; upload: WallpaperUpload }
	| { ok: false; error: "canceled" | "too-large" | "unsupported" | "limit" | "failed" };

/** Base URL of the local wallpaper protocol, plus whether scene/web can render live. */
export interface WallpaperOrigin {
	base: string;
	live: boolean;
}

export interface WallpaperPlayRequest {
	id: string;
	fit: WallpaperFit;
	muted: boolean;
}

export interface WallpaperPlay {
	kind: "image" | "video" | "live";
	url: string;
	poster: string | null;
	schemeColor: string | null;
	title: string;
	type: WeWallpaperType;
}

export function wallpaperPreviewUrl(base: string, id: string): string {
	return `${base}/preview/${encodeURIComponent(id)}`;
}

export function wallpaperUploadUrl(base: string, id: string): string {
	return `${base}/upload/${encodeURIComponent(id)}`;
}
