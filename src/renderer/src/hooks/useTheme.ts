// Ported from Synara's web appearance hook: persists the Codex-style theme store
// and projects the active pack into DOM CSS variables.

import { useEffect, useSyncExternalStore } from "react";
import { isMacNavigatorPlatform } from "../lib/utils";
import { DEFAULT_SHELL_INFO, type WindowMaterial } from "../../../shared/window";
import {
	DEFAULT_THEME_STATE,
	type ChromeTheme,
	type ThemeFonts,
	type ThemeMode,
	type ThemePack,
	type ThemeState,
	type ThemeVariant,
	areThemePacksEqual,
	buildThemeCssVariables,
	canParseThemeShareString,
	createThemeShareString,
	parseStoredThemeState,
	resetThemeVariant as resetThemeVariantState,
	resolveThemePack,
	resolveThemeVariant,
	serializeThemeState,
	setThemeCodeThemeId,
	setThemeFonts,
	updateChromeTheme,
	updateThemePackFromShareString,
} from "../theme/theme.logic";

type ThemeSnapshot = {
	state: ThemeState;
	systemDark: boolean;
};

const STORAGE_KEY = "nekocode:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastSnapshotKey = "";
let lastDesktopTheme: ThemeMode | null = null;

const isElectronRuntime = typeof window !== "undefined" && "nekocode" in window;
// Read straight off the bridge rather than through `api`: the theme is applied at
// module load, before React mounts, and this only needs the one synchronous value
// the preload already resolved.
//
// A module-level value, not a hook one, because the first paint happens here —
// before any component runs. Changing the material re-runs `applyThemeState`,
// which is what turns the new shell on.
const initialShell = isElectronRuntime ? window.nekocode?.shell : undefined;
let windowMaterial: WindowMaterial = initialShell?.material ?? DEFAULT_SHELL_INFO.material;
/** What this machine can composite; the picker greys out the rest. */
const supportedMaterials: readonly WindowMaterial[] =
	initialShell?.materials ?? DEFAULT_SHELL_INFO.materials;

function setWindowMaterialState(material: WindowMaterial) {
	if (windowMaterial === material) return;
	windowMaterial = material;
	applyThemeState(readStoredThemeState(), true);
	emitChange();
}

function emitChange() {
	for (const listener of listeners) {
		listener();
	}
}

function hasThemeStorage(): boolean {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark(): boolean {
	return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

function readStoredThemeState(): ThemeState {
	if (!hasThemeStorage()) return DEFAULT_THEME_STATE;
	try {
		return parseStoredThemeState(localStorage.getItem(STORAGE_KEY));
	} catch {
		return DEFAULT_THEME_STATE;
	}
}

function writeStoredThemeState(state: ThemeState) {
	if (!hasThemeStorage()) return;
	localStorage.setItem(STORAGE_KEY, serializeThemeState(state));
}

function getSnapshot(): ThemeSnapshot {
	const state = readStoredThemeState();
	const systemDark = state.mode === "system" ? getSystemDark() : false;
	const snapshotKey = `${serializeThemeState(state)}|${systemDark ? "dark" : "light"}`;
	if (lastSnapshot && lastSnapshotKey === snapshotKey) return lastSnapshot;
	lastSnapshotKey = snapshotKey;
	lastSnapshot = { state, systemDark };
	return lastSnapshot;
}

function updateStoredThemeState(update: (state: ThemeState) => ThemeState) {
	const nextState = update(readStoredThemeState());
	writeStoredThemeState(nextState);
	applyThemeState(nextState, true);
	emitChange();
}

function subscribe(listener: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	listeners.push(listener);

	const mediaQuery = window.matchMedia(MEDIA_QUERY);
	const handleMediaChange = () => {
		const state = readStoredThemeState();
		if (state.mode === "system") applyThemeState(state, true);
		emitChange();
	};
	const handleStorage = (event: StorageEvent) => {
		if (event.key !== STORAGE_KEY) return;
		applyThemeState(readStoredThemeState(), true);
		emitChange();
	};

	mediaQuery.addEventListener("change", handleMediaChange);
	window.addEventListener("storage", handleStorage);

	return () => {
		listeners = listeners.filter((currentListener) => currentListener !== listener);
		mediaQuery.removeEventListener("change", handleMediaChange);
		window.removeEventListener("storage", handleStorage);
	};
}

function applyThemeState(state: ThemeState, suppressTransitions = false) {
	if (typeof document === "undefined" || typeof window === "undefined") return;
	const root = document.documentElement;
	if (
		typeof root.classList?.toggle !== "function" ||
		typeof root.style?.setProperty !== "function" ||
		typeof root.style?.removeProperty !== "function"
	) {
		return;
	}

	if (suppressTransitions) root.classList.add("no-transitions");

	const variant = resolveThemeVariant(state.mode, getSystemDark());
	const activeTheme = resolveThemePack(state, variant);
	const cssVariableBuild = buildThemeCssVariables(activeTheme, variant, {
		electron: isElectronRuntime,
		isMac: isMacNavigatorPlatform(),
		windowMaterial,
		systemUiFont: state.systemUiFont,
	});

	root.classList.toggle("dark", variant === "dark");
	root.setAttribute("data-code-theme-id", activeTheme.codeThemeId);
	root.setAttribute("data-theme-mode", state.mode);
	root.setAttribute("data-theme-variant", variant);
	root.setAttribute("data-window-material", cssVariableBuild.material);

	for (const [name, value] of Object.entries(cssVariableBuild.variables)) {
		if (value.trim().length === 0) {
			root.style.removeProperty(name);
			continue;
		}
		root.style.setProperty(name, value);
	}

	syncDesktopTheme(state.mode);

	if (suppressTransitions) {
		// Force a reflow so the no-transitions class takes effect before removal.
		void root.offsetHeight;
		requestAnimationFrame(() => {
			root.classList.remove("no-transitions");
		});
	}
}

function syncDesktopTheme(theme: ThemeMode) {
	if (typeof window === "undefined") return;
	const bridge = window.nekocode;
	if (!bridge || lastDesktopTheme === theme) return;
	lastDesktopTheme = theme;
	void bridge.setTheme(theme).catch(() => {
		if (lastDesktopTheme === theme) lastDesktopTheme = null;
	});
}

// Apply immediately on module load to minimize flash before React mounts.
if (typeof document !== "undefined") {
	applyThemeState(readStoredThemeState());
}

function setTheme(nextTheme: ThemeMode) {
	updateStoredThemeState((state) => ({ ...state, mode: nextTheme }));
}

function setSystemUiFont(enabled: boolean) {
	updateStoredThemeState((state) => ({ ...state, systemUiFont: enabled }));
}

/**
 * Ask main for a new window material. The bridge is the one that knows what the
 * machine can render, so the value it echoes back is what gets applied — a
 * rejected material leaves the shell exactly as it was rather than half-applied.
 */
async function setWindowMaterial(material: WindowMaterial) {
	if (!isElectronRuntime) {
		setWindowMaterialState(material);
		return;
	}
	try {
		const shell = await window.nekocode?.setWindowMaterial?.(material);
		setWindowMaterialState(shell?.material ?? material);
	} catch {
		// Unsupported on this build, or the window went away mid-flight; the
		// picker keeps showing whatever the shell is actually using.
	}
}

function resetThemeVariant(variant: ThemeVariant) {
	updateStoredThemeState((state) => resetThemeVariantState(state, variant));
}

function resetAllThemes() {
	updateStoredThemeState(() => DEFAULT_THEME_STATE);
}

function updateThemePack(variant: ThemeVariant, patch: Partial<ChromeTheme>) {
	updateStoredThemeState((state) => updateChromeTheme(state, variant, patch));
}

function updateThemeFonts(variant: ThemeVariant, patch: Partial<ThemeFonts>) {
	updateStoredThemeState((state) => setThemeFonts(state, variant, patch));
}

function setCodeThemeId(variant: ThemeVariant, codeThemeId: string) {
	updateStoredThemeState((state) => setThemeCodeThemeId(state, variant, codeThemeId));
}

export function useTheme() {
	const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => ({
		state: DEFAULT_THEME_STATE,
		systemDark: false,
	}));
	const theme = snapshot.state.mode;
	const resolvedTheme = resolveThemeVariant(theme, snapshot.systemDark);
	const activeTheme = resolveThemePack(snapshot.state, resolvedTheme);
	const darkTheme = resolveThemePack(snapshot.state, "dark");
	const lightTheme = resolveThemePack(snapshot.state, "light");
	const defaultActiveTheme = resolveThemePack(DEFAULT_THEME_STATE, resolvedTheme);
	const isDefaultActiveTheme = areThemePacksEqual(activeTheme, defaultActiveTheme);

	const canImportThemeString = (value: string, variant: ThemeVariant = resolvedTheme) =>
		canParseThemeShareString(value, variant);

	const importThemeString = (value: string, variant: ThemeVariant = resolvedTheme) => {
		updateStoredThemeState((state) => updateThemePackFromShareString(state, value, variant));
	};

	const exportThemeString = (variant: ThemeVariant = resolvedTheme) =>
		createThemeShareString(variant, resolveThemePack(snapshot.state, variant));

	const resetActiveTheme = () => {
		updateStoredThemeState((state) => resetThemeVariantState(state, resolvedTheme));
	};

	const isDefaultThemePack = (variant: ThemeVariant) =>
		areThemePacksEqual(
			resolveThemePack(snapshot.state, variant),
			resolveThemePack(DEFAULT_THEME_STATE, variant),
		);

	useEffect(() => {
		applyThemeState(snapshot.state);
	}, [snapshot.state]);

	return {
		activeTheme,
		canImportThemeString,
		systemUiFont: snapshot.state.systemUiFont,
		setSystemUiFont,
		windowMaterial,
		setWindowMaterial,
		supportedWindowMaterials: supportedMaterials,
		darkTheme,
		defaultActiveTheme,
		exportThemeString,
		importThemeString,
		isDefaultActiveTheme,
		isDefaultThemePack,
		lightTheme,
		resetActiveTheme,
		resetAllThemes,
		resetThemeVariant,
		resolvedTheme,
		setCodeThemeId,
		setTheme,
		theme,
		themeState: snapshot.state,
		updateThemeFonts,
		updateThemePack,
	} as const;
}

export type { ChromeTheme, ThemeFonts, ThemeMode, ThemePack, ThemeState, ThemeVariant };
