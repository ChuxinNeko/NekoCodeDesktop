import { useEffect, useRef, useSyncExternalStore } from "react";
import {
	DEFAULT_SHORTCUT_BINDINGS, formatShortcut, matchesShortcut, normalizeShortcutOverrides,
	resolveShortcutBindings, shortcutConflict, SHORTCUTS, validShortcut,
	type ShortcutId, type ShortcutOverrides,
} from "../lib/shortcuts";

const STORAGE_KEY = "nekocode:shortcuts";
let overrides: ShortcutOverrides | undefined;
let bindings = DEFAULT_SHORTCUT_BINDINGS;
const listeners = new Set<() => void>();

function read() {
	if (overrides === undefined) {
		try { overrides = normalizeShortcutOverrides(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")); }
		catch { overrides = {}; }
		bindings = resolveShortcutBindings(overrides);
	}
	return bindings;
}

function onStorage(event: StorageEvent) {
	if (event.key !== STORAGE_KEY && event.key !== null) return;
	overrides = undefined;
	read();
	for (const notify of listeners) notify();
}

function subscribe(listener: () => void) {
	if (!listeners.size) window.addEventListener("storage", onStorage);
	listeners.add(listener);
	return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener("storage", onStorage); };
}

function save(next: ShortcutOverrides) {
	overrides = next;
	bindings = resolveShortcutBindings(next);
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Session-only if storage is unavailable. */ }
	for (const notify of listeners) notify();
}

export function setShortcut(id: ShortcutId, binding: string | null): ShortcutId | null {
	const current = read();
	if (binding) {
		const entry = SHORTCUTS.find((entry) => entry.id === id)!;
		if (!validShortcut(binding, entry.scope)) throw new Error("Invalid shortcut");
		const conflict = shortcutConflict(id, binding, current);
		if (conflict) return conflict;
	}
	save({ ...overrides, [id]: binding });
	return null;
}

export function resetShortcuts() { save({}); }

export function useShortcuts() {
	const current = useSyncExternalStore(subscribe, read, () => DEFAULT_SHORTCUT_BINDINGS);
	return { bindings: current, label: (id: ShortcutId) => formatShortcut(current[id]) };
}

export type ShortcutHandlers = Partial<Record<ShortcutId, () => void | boolean>>;

/** Central guards shared by the application and IDE, before Monaco consumes keys. */
export function useShortcutHandlers(handlers: ShortcutHandlers, enabled = true) {
	const { bindings: current } = useShortcuts();
	const latest = useRef(handlers);
	latest.current = handlers;
	useEffect(() => {
		if (!enabled) return;
		const keydown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("[data-shortcut-recorder], [data-agent-screen], canvas, [inert]")) return;
			if (target?.closest('input, textarea, [contenteditable="true"]') && (event.ctrlKey || event.metaKey) && !event.altKey &&
				["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyY"].includes(event.code)) return;
			// Avoid scanning overlays for ordinary typing and navigation keys.
			if (!Object.keys(latest.current).some((id) => matchesShortcut(event, current[id as ShortcutId]))) return;
			// Dialogs and menus own the keyboard while open, including custom recorders.
			if ([...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .monaco-editor .quick-input-widget')]
				.some((element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")) return;
			for (const [id, handler] of Object.entries(latest.current) as Array<[ShortcutId, () => void | boolean]>) {
				if (!matchesShortcut(event, current[id])) continue;
				if (target?.closest(".xterm") && !["agent.terminal", "ide.terminal", "app.focusComposer", "ide.focusChat"].includes(id)) return;
				if (handler() === false) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
		};
		window.addEventListener("keydown", keydown, true);
		return () => window.removeEventListener("keydown", keydown, true);
	}, [current, enabled]);
}
