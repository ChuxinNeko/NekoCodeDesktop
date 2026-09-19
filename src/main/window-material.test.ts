import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	WindowMaterialStore,
	applyWindowMaterial,
	supportedWindowMaterials,
	supportsSystemBackdrops,
	windowsBuildNumber,
	type WindowMaterialTarget,
} from "./window-material";

const WIN11_22H2 = "10.0.22621";
const WIN11_21H2 = "10.0.22000";
const WIN10 = "10.0.19045";

/** Records the calls the material helpers make, the way Electron would receive them. */
function fakeWindow(options?: { destroyed?: boolean; rejectBackdrop?: boolean }) {
	const calls: string[] = [];
	const target: WindowMaterialTarget = {
		isDestroyed: () => options?.destroyed === true,
		setBackgroundColor: (color) => calls.push(`bg:${color}`),
		setBackgroundMaterial: (material) => {
			if (options?.rejectBackdrop) throw new Error("unsupported");
			calls.push(`material:${material}`);
		},
	};
	return { calls, target };
}

describe("windowsBuildNumber", () => {
	test("reads the build out of the release string", () => {
		expect(windowsBuildNumber("10.0.22621")).toBe(22621);
		expect(windowsBuildNumber("10.0.19045.4046")).toBe(19045);
	});

	test("reports 0 for a release it cannot parse", () => {
		// Darwin/Linux report a kernel version with no build field at all.
		expect(windowsBuildNumber("23.4.0")).toBe(0);
		expect(windowsBuildNumber("")).toBe(0);
		expect(windowsBuildNumber("nonsense")).toBe(0);
	});
});

describe("supportsSystemBackdrops", () => {
	test("accepts Windows 11 22H2 and up", () => {
		expect(supportsSystemBackdrops("win32", 22621)).toBe(true);
		expect(supportsSystemBackdrops("win32", 22631)).toBe(true);
	});

	test("refuses the builds whose DWM has no backdrop type", () => {
		// These are the ones that would paint a transparent window over nothing.
		expect(supportsSystemBackdrops("win32", 22000)).toBe(false);
		expect(supportsSystemBackdrops("win32", 19045)).toBe(false);
	});

	test("refuses every non-Windows platform", () => {
		expect(supportsSystemBackdrops("darwin", 22621)).toBe(false);
		expect(supportsSystemBackdrops("linux", 22621)).toBe(false);
	});
});

describe("supportedWindowMaterials", () => {
	test("offers every material on a build that can composite them", () => {
		expect(supportedWindowMaterials("win32", 22621)).toEqual(["opaque", "mica", "acrylic"]);
	});

	test("offers only the opaque shell anywhere else", () => {
		expect(supportedWindowMaterials("win32", 19045)).toEqual(["opaque"]);
		expect(supportedWindowMaterials("darwin", 22621)).toEqual(["opaque"]);
		expect(supportedWindowMaterials("linux", 22621)).toEqual(["opaque"]);
	});
});

describe("applyWindowMaterial", () => {
	test("turns the backdrop on and clears the window's own background", () => {
		const { calls, target } = fakeWindow();
		applyWindowMaterial(target, "mica", "#f9f9f7", "win32");
		// The material is composited behind the window, so the window itself has
		// to paint nothing for it to be visible.
		expect(calls).toEqual(["material:mica", "bg:#00000000"]);
	});

	test("restores the opaque shell and its color", () => {
		const { calls, target } = fakeWindow();
		applyWindowMaterial(target, "opaque", "#1a1a19", "win32");
		expect(calls).toEqual(["material:none", "bg:#1a1a19"]);
	});

	test("never reaches for a backdrop off Windows", () => {
		const { calls, target } = fakeWindow();
		applyWindowMaterial(target, "acrylic", "#1a1a19", "darwin");
		expect(calls).toEqual([]);
	});

	test("leaves a destroyed window alone", () => {
		// The user can pick a material in the tick between the window closing and
		// the IPC landing; calling into it then throws.
		const { calls, target } = fakeWindow({ destroyed: true });
		applyWindowMaterial(target, "mica", "#1a1a19", "win32");
		expect(calls).toEqual([]);
	});

	test("falls back to the opaque shell when the build rejects the backdrop", () => {
		// Windows 10: `setBackgroundMaterial` throws instead of degrading, and
		// without this fallback the window would keep the transparent background.
		const { calls, target } = fakeWindow({ rejectBackdrop: true });
		applyWindowMaterial(target, "mica", "#f9f9f7", "win32");
		expect(calls).toEqual(["bg:#f9f9f7"]);
	});
});

describe("WindowMaterialStore", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "nekocode-material-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	test("has no preference until one is saved", () => {
		expect(new WindowMaterialStore(directory).load()).toBeNull();
	});

	test("round-trips a saved material", () => {
		new WindowMaterialStore(directory).save("acrylic");
		expect(new WindowMaterialStore(directory).load()).toBe("acrylic");
	});

	test("a saved null hands the choice back to the default", () => {
		const store = new WindowMaterialStore(directory);
		store.save("mica");
		store.save(null);
		expect(store.load()).toBeNull();
	});

	test("ignores a file that does not hold a material", () => {
		const store = new WindowMaterialStore(directory);
		store.save("mica");
		Bun.write(join(directory, "window-material.json"), "{ not json");
		expect(new WindowMaterialStore(directory).load()).toBeNull();
	});

	test("resolves to the default material on a machine that supports it", () => {
		expect(new WindowMaterialStore(directory).resolve(["opaque", "mica", "acrylic"])).toBe("mica");
	});

	test("resolves a saved choice that this machine can render", () => {
		new WindowMaterialStore(directory).save("acrylic");
		expect(new WindowMaterialStore(directory).resolve(["opaque", "mica", "acrylic"])).toBe(
			"acrylic",
		);
	});

	test("never applies a material this machine cannot render", () => {
		// A preference saved on Windows 11, read back on Windows 10.
		new WindowMaterialStore(directory).save("mica");
		expect(new WindowMaterialStore(directory).resolve(["opaque"])).toBe("opaque");
	});
});
