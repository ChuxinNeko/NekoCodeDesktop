import { expect, test } from "bun:test";
import { api, optionalApi } from "./api";

/**
 * These run in order on purpose: `optionalApi` caches the bridge once it finds
 * one, so the bridgeless case has to be asked first.
 */

test("optionalApi yields null where no bridge exists", () => {
	Object.assign(globalThis, { window: {} });
	// The phone app renders shared renderer components in a WebView with neither
	// the preload bridge nor the WebUI runtime. Anything they touch while
	// rendering goes through this, and it must not throw: a thrown error there
	// unmounts the whole tree and the screen goes white.
	expect(optionalApi()).toBeNull();
	expect(optionalApi()?.homeDir ?? "").toBe("");
});

test("api itself throws where no bridge exists", () => {
	Object.assign(globalThis, { window: {} });
	// Reaching for `api` is a claim that there is a bridge, so a missing one is
	// a bug worth reporting rather than an undefined to paper over.
	expect(() => api.homeDir).toThrow(/bridge unavailable/);
});

test("optionalApi yields the preload bridge when the desktop app hosts the page", () => {
	const bridge = { homeDir: "/home/neko" };
	Object.assign(globalThis, { window: { nekocode: bridge } });
	expect(optionalApi()).toBe(bridge as never);
	expect(api.homeDir).toBe("/home/neko");
});
