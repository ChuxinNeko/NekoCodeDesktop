import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SHORTCUT_BINDINGS, formatShortcut, matchesShortcut, normalizeShortcutOverrides,
	resolveShortcutBindings, shortcutConflict, shortcutFromEvent, SHORTCUTS, validShortcut,
	type ShortcutKeyEvent,
} from "../../../src/renderer/src/lib/shortcuts";

const key = (code: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
	code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers,
});

describe("application shortcuts", () => {
	test("every default is valid and no simultaneous actions share a shortcut", () => {
		for (const command of SHORTCUTS) {
			expect(validShortcut(command.defaultBinding, command.scope)).toBe(true);
			expect(shortcutConflict(command.id, command.defaultBinding, DEFAULT_SHORTCUT_BINDINGS)).toBeNull();
		}
		expect(resolveShortcutBindings({})).toEqual(DEFAULT_SHORTCUT_BINDINGS);
	});
	test("Ctrl and Command map to the platform primary modifier with exact modifier matching", () => {
		expect(matchesShortcut(key("KeyN", { ctrlKey: true }), "Mod+KeyN", false)).toBe(true);
		expect(matchesShortcut(key("KeyN", { metaKey: true }), "Mod+KeyN", true)).toBe(true);
		expect(matchesShortcut(key("KeyN", { ctrlKey: true }), "Mod+KeyN", true)).toBe(false);
		expect(matchesShortcut(key("KeyN", { metaKey: true }), "Mod+KeyN", false)).toBe(false);
		expect(matchesShortcut(key("KeyN", { ctrlKey: true, shiftKey: true }), "Mod+KeyN", false)).toBe(false);
		expect(matchesShortcut(key("KeyN", { ctrlKey: true, altKey: true }), "Mod+KeyN", false)).toBe(false);
	});
	test("physical punctuation, numpad Enter and virtual keyboard Enter are recognized", () => {
		expect(shortcutFromEvent(key("Slash", { ctrlKey: true, shiftKey: true, key: "?" }), false)).toBe("Mod+Shift+Slash");
		expect(matchesShortcut(key("NumpadEnter"), "Enter", false)).toBe(true);
		expect(matchesShortcut(key("", { key: "Enter" }), "Enter", false)).toBe(true);
	});
	test("IME composition, AltGr and modifier-only presses cannot invoke or record actions", () => {
		expect(shortcutFromEvent(key("Enter", { isComposing: true }), false)).toBeNull();
		expect(shortcutFromEvent(key("Enter", { keyCode: 229 }), false)).toBeNull();
		expect(shortcutFromEvent(key("KeyN", { ctrlKey: true, altKey: true, getModifierState: (name) => name === "AltGraph" }), false)).toBeNull();
		expect(shortcutFromEvent(key("ControlLeft", { ctrlKey: true }), false)).toBeNull();
	});
	test("agent and IDE share defaults, while application and composer conflicts are detected", () => {
		expect(shortcutConflict("agent.files", "Mod+KeyP", DEFAULT_SHORTCUT_BINDINGS)).toBeNull();
		expect(shortcutConflict("app.newSession", "Mod+KeyP", DEFAULT_SHORTCUT_BINDINGS)).toBe("agent.files");
		expect(shortcutConflict("app.newSession", "Mod+Enter", DEFAULT_SHORTCUT_BINDINGS)).toBe("composer.background");
	});
	test("reload preserves overrides and disabled commands, ignoring corrupt or unknown preferences", () => {
		const raw = JSON.parse(JSON.stringify({ "app.newSession": "Mod+Alt+KeyN", "agent.files": null, "app.settings": "KeyQ", "unknown": "Mod+KeyU" }));
		const normalized = normalizeShortcutOverrides(raw);
		expect(normalized).toEqual({ "app.newSession": "Mod+Alt+KeyN", "agent.files": null });
		const resolved = resolveShortcutBindings(normalized);
		expect(resolved["app.newSession"]).toBe("Mod+Alt+KeyN");
		expect(resolved["agent.files"]).toBeNull();
		expect(matchesShortcut(key("KeyN", { ctrlKey: true }), resolved["app.newSession"], false)).toBe(false);
		expect(matchesShortcut(key("KeyN", { ctrlKey: true, altKey: true }), resolved["app.newSession"], false)).toBe(true);
		expect(normalizeShortcutOverrides(null)).toEqual({});
	});
	test("an externally edited conflict cannot dispatch two commands", () => {
		const resolved = resolveShortcutBindings({ "app.newSession": "Mod+KeyP" });
		expect(resolved["app.newSession"]).toBe("Mod+KeyP");
		expect(resolved["agent.files"]).toBeNull();
		expect(resolved["ide.quickOpen"]).toBeNull();
	});
	test("typing and navigation cannot become unmodified application shortcuts", () => {
		for (const value of ["KeyA", "Shift+KeyA", "Space", "Tab", "Enter", "ArrowUp", "Mod+Mod+KeyN", "Shift+Mod+KeyN"]) expect(validShortcut(value, "app")).toBe(false);
		expect(validShortcut("F6", "app")).toBe(true);
		expect(validShortcut("Shift+Enter", "composer")).toBe(true);
		expect(validShortcut("Mod+Enter", "composer")).toBe(true);
		expect(validShortcut("Mod+KeyN", "composer")).toBe(false);
		expect(validShortcut("Alt+Enter", "composer")).toBe(false);
	});
	test("labels display the platform modifier and disabled commands have no stale hint", () => {
		expect(formatShortcut("Mod+Shift+KeyP", false)).toBe("Ctrl+Shift+P");
		expect(formatShortcut("Mod+Comma", true)).toBe("⌘+,");
		expect(formatShortcut("Mod+Backquote", false)).toBe("Ctrl+`");
		expect(formatShortcut(null)).toBe("");
	});
});
