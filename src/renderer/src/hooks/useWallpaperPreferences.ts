import { useSyncExternalStore } from "react";
import {
	DEFAULT_WALLPAPER_PREFERENCES,
	normalizeWallpaperPreferences,
	readWallpaperPreferences,
	writeWallpaperPreferences,
	type WallpaperPreferences,
} from "../lib/wallpaperPreferences";

const STORAGE_KEY = "nekocode:wallpaper";

let listeners: Array<() => void> = [];
let current = readWallpaperPreferences();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.push(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key !== STORAGE_KEY) return;
		current = readWallpaperPreferences();
		emit();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners = listeners.filter((item) => item !== listener);
		window.removeEventListener("storage", onStorage);
	};
}

function snapshot(): WallpaperPreferences {
	return current;
}

export function updateWallpaperPreferences(patch: Partial<WallpaperPreferences>) {
	current = normalizeWallpaperPreferences({ ...current, ...patch });
	writeWallpaperPreferences(current);
	emit();
}

export function resetWallpaperPreferences() {
	current = DEFAULT_WALLPAPER_PREFERENCES;
	writeWallpaperPreferences(current);
	emit();
}

export function useWallpaperPreferences() {
	const preferences = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_WALLPAPER_PREFERENCES);
	return { preferences, updatePreferences: updateWallpaperPreferences, resetPreferences: resetWallpaperPreferences } as const;
}
