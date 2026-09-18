import { describe, expect, test } from "bun:test";

// Same bridge stand-in as the other renderer tests: importing a panel component
// must not reach for Electron's preload API.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { syncGuestVisibility } = await import("../renderer/src/components/BrowserPanel");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

/** A stand-in webview that just remembers which visibility class it carries. */
function guest() {
	const classes = new Set<string>(["invisible"]);
	return {
		classList: {
			toggle(name: string, force: boolean) {
				if (force) classes.add(name);
				else classes.delete(name);
			},
		},
		get shown() {
			return classes.has("visible") && !classes.has("invisible");
		},
		get hidden() {
			return classes.has("invisible") && !classes.has("visible");
		},
	};
}

describe("syncGuestVisibility", () => {
	test("shows the active tab's guest and hides the rest", () => {
		const a = guest();
		const b = guest();
		syncGuestVisibility(
			[
				["a", a],
				["b", b],
			],
			"a",
			true,
		);

		expect(a.shown).toBe(true);
		expect(b.hidden).toBe(true);
	});

	test("hides every guest when the dock is not showing the browser", () => {
		// The regression: the dock had switched to another tool, the tab strip
		// said so, and the guest went on painting over it. `.visible` is
		// `visibility: visible`, which overrides the `invisible` the dock puts on
		// the pane — inheritance does not save you from a descendant that
		// re-declares the property.
		const a = guest();
		const b = guest();
		syncGuestVisibility(
			[
				["a", a],
				["b", b],
			],
			"a",
			false,
		);

		expect(a.hidden).toBe(true);
		expect(b.hidden).toBe(true);
	});

	test("a guest is never marked both visible and invisible", () => {
		const a = guest();
		syncGuestVisibility([["a", a]], "a", true);
		expect(a.shown).toBe(true);
		syncGuestVisibility([["a", a]], "a", false);
		expect(a.hidden).toBe(true);
		syncGuestVisibility([["a", a]], "a", true);
		expect(a.shown).toBe(true);
	});

	test("no active tab means nothing is shown", () => {
		const a = guest();
		syncGuestVisibility([["a", a]], "", true);
		expect(a.hidden).toBe(true);
	});
});
