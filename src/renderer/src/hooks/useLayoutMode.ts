import { useSyncExternalStore } from "react";
import { api } from "../api";
import type { LayoutMode } from "../components/LayoutModeSwitch";

const STORAGE_KEY = "nekocode:layout-mode";
const CHANGE_EVENT = "nekocode:layout-mode-changed";

function readLayoutMode(): LayoutMode {
	try {
		return localStorage.getItem(STORAGE_KEY) === "ide" ? "ide" : "agent";
	} catch {
		return "agent";
	}
}

let sessionMode: LayoutMode | undefined;
const getSnapshot = () => sessionMode ?? readLayoutMode();

function subscribe(listener: () => void) {
	const onStorage = (event: StorageEvent) => {
		if (event.key !== null && event.key !== STORAGE_KEY) return;
		sessionMode = undefined;
		listener();
	};
	window.addEventListener(CHANGE_EVENT, listener);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(CHANGE_EVENT, listener);
		window.removeEventListener("storage", onStorage);
	};
}

function saveLayoutMode(mode: LayoutMode) {
	sessionMode = mode;
	try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* Keep the choice for this session. */ }
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Shared by the workbench, General settings, and first-launch setup. */
export function useLayoutMode() {
	const available = api.runtime === "electron";
	const storedMode = useSyncExternalStore(subscribe, getSnapshot, () => "agent" as const);
	return {
		available,
		layoutMode: available ? storedMode : "agent" as LayoutMode,
		setLayoutMode: (mode: LayoutMode) => { if (available) saveLayoutMode(mode); },
	};
}
