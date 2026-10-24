import type { TranslationKey } from "../i18n";

export type ShortcutScope = "app" | "agent" | "ide" | "composer";
export interface ShortcutDefinition {
	id: string;
	labelKey: TranslationKey;
	scope: ShortcutScope;
	defaultBinding: string;
	desktopOnly?: boolean;
}

/** Physical codes keep punctuation and shifted keys stable across keyboard layouts. */
export const SHORTCUTS = [
	{ id: "app.newSession", labelKey: "sidebar.newSession", scope: "app", defaultBinding: "Mod+KeyN" },
	{ id: "app.openProject", labelKey: "ide.openProject", scope: "app", defaultBinding: "Mod+KeyO" },
	{ id: "app.settings", labelKey: "settings.title", scope: "app", defaultBinding: "Mod+Comma" },
	{ id: "app.shortcuts", labelKey: "settings.section.shortcuts", scope: "app", defaultBinding: "Mod+Shift+Slash" },
	{ id: "app.chat", labelKey: "nav.chat", scope: "app", defaultBinding: "Mod+Digit1" },
	{ id: "app.tasks", labelKey: "nav.tasks", scope: "app", defaultBinding: "Mod+Digit2" },
	{ id: "app.review", labelKey: "nav.review", scope: "app", defaultBinding: "Mod+Digit3" },
	{ id: "app.github", labelKey: "nav.pullRequests", scope: "app", defaultBinding: "Mod+Digit4" },
	{ id: "app.automations", labelKey: "nav.automations", scope: "app", defaultBinding: "Mod+Digit5" },
	{ id: "app.sidebar", labelKey: "shortcuts.toggleSidebar", scope: "app", defaultBinding: "Mod+KeyB" },
	{ id: "app.dock", labelKey: "shortcuts.toggleDock", scope: "app", defaultBinding: "Mod+Shift+KeyB" },
	{ id: "app.focusComposer", labelKey: "shortcuts.focusComposer", scope: "app", defaultBinding: "Mod+Shift+KeyL" },
	{ id: "app.stop", labelKey: "shortcuts.stop", scope: "app", defaultBinding: "Mod+Shift+Backspace" },
	{ id: "app.layout", labelKey: "layout.switch", scope: "app", defaultBinding: "Mod+Alt+KeyL", desktopOnly: true },
	{ id: "app.theme", labelKey: "sidebar.toggleTheme", scope: "app", defaultBinding: "Mod+Alt+KeyT" },
	{ id: "agent.terminal", labelKey: "chat.terminal", scope: "agent", defaultBinding: "Mod+Backquote" },
	{ id: "agent.browser", labelKey: "nav.browser", scope: "agent", defaultBinding: "Mod+KeyT", desktopOnly: true },
	{ id: "agent.files", labelKey: "dock.files", scope: "agent", defaultBinding: "Mod+KeyP" },
	{ id: "agent.review", labelKey: "nav.review", scope: "agent", defaultBinding: "Mod+Shift+KeyG" },
	{ id: "agent.checkpoints", labelKey: "checkpoint.panelTitle", scope: "agent", defaultBinding: "Mod+Shift+KeyH" },
	{ id: "agent.agentmap", labelKey: "agentMap.title", scope: "agent", defaultBinding: "Mod+Shift+KeyA" },
	{ id: "agent.desktop", labelKey: "dock.desktop", scope: "agent", defaultBinding: "Mod+Shift+KeyD", desktopOnly: true },
	{ id: "ide.quickOpen", labelKey: "ide.command.quickOpen", scope: "ide", defaultBinding: "Mod+KeyP", desktopOnly: true },
	{ id: "ide.palette", labelKey: "ide.command.palette", scope: "ide", defaultBinding: "Mod+Shift+KeyP", desktopOnly: true },
	{ id: "ide.explorer", labelKey: "ide.explorer.title", scope: "ide", defaultBinding: "Mod+Shift+KeyE", desktopOnly: true },
	{ id: "ide.search", labelKey: "ide.search.title", scope: "ide", defaultBinding: "Mod+Shift+KeyF", desktopOnly: true },
	{ id: "ide.scm", labelKey: "ide.scm.title", scope: "ide", defaultBinding: "Mod+Shift+KeyG", desktopOnly: true },
	{ id: "ide.extensions", labelKey: "ide.ext.title", scope: "ide", defaultBinding: "Mod+Shift+KeyX", desktopOnly: true },
	{ id: "ide.terminal", labelKey: "ide.command.toggleTerminal", scope: "ide", defaultBinding: "Mod+Backquote", desktopOnly: true },
	{ id: "ide.focusChat", labelKey: "ide.command.toggleChat", scope: "ide", defaultBinding: "Mod+KeyI", desktopOnly: true },
	{ id: "ide.toggleChat", labelKey: "shortcuts.toggleChat", scope: "ide", defaultBinding: "Mod+Alt+KeyB", desktopOnly: true },
	{ id: "ide.save", labelKey: "ide.command.save", scope: "ide", defaultBinding: "Mod+KeyS", desktopOnly: true },
	{ id: "ide.saveAll", labelKey: "ide.command.saveAll", scope: "ide", defaultBinding: "Mod+Alt+KeyS", desktopOnly: true },
	{ id: "ide.closeTab", labelKey: "ide.tabs.close", scope: "ide", defaultBinding: "Mod+KeyW", desktopOnly: true },
	{ id: "ide.addToChat", labelKey: "ide.command.addToChat", scope: "ide", defaultBinding: "Mod+KeyL", desktopOnly: true },
	{ id: "ide.inlineEdit", labelKey: "ide.command.inlineEdit", scope: "ide", defaultBinding: "Mod+KeyK", desktopOnly: true },
	{ id: "ide.wordWrap", labelKey: "ide.command.wordWrap", scope: "ide", defaultBinding: "Alt+KeyZ", desktopOnly: true },
	{ id: "ide.nextTab", labelKey: "shortcuts.nextTab", scope: "ide", defaultBinding: "Mod+Tab", desktopOnly: true },
	{ id: "ide.previousTab", labelKey: "shortcuts.previousTab", scope: "ide", defaultBinding: "Mod+Shift+Tab", desktopOnly: true },
	{ id: "composer.send", labelKey: "shortcuts.send", scope: "composer", defaultBinding: "Enter" },
	{ id: "composer.background", labelKey: "shortcuts.background", scope: "composer", defaultBinding: "Mod+Enter" },
] as const satisfies readonly ShortcutDefinition[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];
export type ShortcutOverrides = Partial<Record<ShortcutId, string | null>>;
export type ShortcutBindings = Record<ShortcutId, string | null>;
export const DEFAULT_SHORTCUT_BINDINGS = Object.fromEntries(SHORTCUTS.map((entry) => [entry.id, entry.defaultBinding])) as ShortcutBindings;

export interface ShortcutKeyEvent {
	code: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	key?: string;
	isComposing?: boolean;
	keyCode?: number;
	getModifierState?: (key: string) => boolean;
}

export function isMacKeyboard(): boolean {
	return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

const KEY_CODE = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Enter|Tab|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

export function validShortcut(binding: string, scope: ShortcutScope): boolean {
	const parts = binding.split("+");
	const code = parts.pop() ?? "";
	if (!KEY_CODE.test(code)) return false;
	if (parts.some((part) => !["Mod", "Alt", "Shift"].includes(part)) || new Set(parts).size !== parts.length) return false;
	if (parts.join("+") !== ["Mod", "Alt", "Shift"].filter((part) => parts.includes(part)).join("+")) return false;
	if (scope === "composer") return code === "Enter" && !parts.includes("Alt");
	return parts.includes("Mod") || parts.includes("Alt") || /^F\d+$/.test(code);
}

export function shortcutFromEvent(event: ShortcutKeyEvent, mac = isMacKeyboard()): string | null {
	if (event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return null;
	if (mac ? event.ctrlKey : event.metaKey) return null;
	const code = event.code === "NumpadEnter" ? "Enter" : event.code || event.key || "";
	if (!KEY_CODE.test(code)) return null;
	return [...((mac ? event.metaKey : event.ctrlKey) ? ["Mod"] : []), ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : []), code].join("+");
}

export function matchesShortcut(event: ShortcutKeyEvent, binding: string | null, mac = isMacKeyboard()): boolean {
	return !!binding && shortcutFromEvent(event, mac) === binding;
}

export function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
	return !(a === "agent" && b === "ide" || a === "ide" && b === "agent");
}

export function shortcutConflict(id: ShortcutId, binding: string, bindings: ShortcutBindings): ShortcutId | null {
	const definition = SHORTCUTS.find((entry) => entry.id === id)!;
	return SHORTCUTS.find((entry) => entry.id !== id && bindings[entry.id] === binding && scopesOverlap(entry.scope, definition.scope))?.id ?? null;
}

export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const overrides: ShortcutOverrides = {};
	for (const entry of SHORTCUTS) {
		const binding = (value as Record<string, unknown>)[entry.id];
		if (binding === null || typeof binding === "string" && validShortcut(binding, entry.scope)) overrides[entry.id] = binding;
	}
	return overrides;
}

/** Malformed or externally edited preferences must never create ambiguous dispatch. */
export function resolveShortcutBindings(overrides: ShortcutOverrides): ShortcutBindings {
	const bindings = { ...DEFAULT_SHORTCUT_BINDINGS, ...overrides };
	// Explicit custom bindings win over defaults. Conflicting defaults are disabled.
	const custom = SHORTCUTS.filter((entry) => Object.hasOwn(overrides, entry.id));
	const remaining = SHORTCUTS.filter((entry) => !Object.hasOwn(overrides, entry.id));
	const accepted: typeof SHORTCUTS[number][] = [];
	for (const entry of [...custom, ...remaining]) {
		if (bindings[entry.id] && accepted.some((other) => scopesOverlap(entry.scope, other.scope) && bindings[entry.id] === bindings[other.id])) bindings[entry.id] = null;
		else accepted.push(entry);
	}
	return bindings;
}

const KEY_LABELS: Record<string, string> = { Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
export function formatShortcut(binding: string | null, mac = isMacKeyboard()): string {
	return binding?.split("+").map((part) => part === "Mod" ? mac ? "⌘" : "Ctrl" : KEY_LABELS[part] ?? part.replace(/^Key|^Digit/, "")).join("+") ?? "";
}
