import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThemeLibrary, resolveThemesDir } from "../../src/main/theme-library";

const base = mkdtempSync(join(tmpdir(), "nekocode-themes-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function themePackage(id: string, accent = "#5666a3"): string {
	return JSON.stringify({
		format: "codex-theme",
		schemaVersion: 1,
		manifest: { id, displayName: id, mode: "light", css: "theme.css", palette: { canvas: "#fafbff", text: "#30384f", accent } },
		css: "body{}",
		art: { filename: "a.png", mimeType: "image/png", base64: PNG },
	});
}

let count = 0;
function library(): ThemeLibrary {
	const trashed: string[] = [];
	const lib = new ThemeLibrary(join(base, `lib-${count++}`), async (path) => {
		trashed.push(path);
		rmSync(path, { recursive: true, force: true });
	});
	return Object.assign(lib, { trashed });
}

/** A dropped file old enough to count as finished writing. */
function drop(dir: string, name: string, content: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	const past = new Date(Date.now() - 10_000);
	utimesSync(path, past, past);
	return path;
}

describe("ThemeLibrary", () => {
	test("sits beside the agent directory unless told otherwise", () => {
		expect(resolveThemesDir({}, join("/home/u", ".nekocode", "agent"))).toBe(join("/home/u", ".nekocode", "themes"));
		expect(resolveThemesDir({ NEKOCODE_THEMES_DIR: "/x/themes" }, "/ignored")).toBe("/x/themes");
	});

	test("installs a package as a manifest and artwork, and lists it", () => {
		const lib = library();
		const theme = lib.install(themePackage("lavender-snow"));
		expect(theme.id).toBe("lavender-snow");
		expect(existsSync(join(lib.dir, "lavender-snow", "theme.json"))).toBe(true);
		expect(existsSync(join(lib.dir, "lavender-snow", "art.png"))).toBe(true);
		expect(lib.snapshot().themes.map((entry) => [entry.id, entry.art])).toEqual([["lavender-snow", true]]);
		expect(lib.art("lavender-snow")).toBe(`data:image/png;base64,${PNG}`);
	});

	test("imports an extracted theme folder", () => {
		const lib = library();
		const source = join(base, "extracted-theme");
		mkdirSync(source, { recursive: true });
		writeFileSync(
			join(source, "theme.json"),
			JSON.stringify({ id: "extracted", displayName: "Extracted", mode: "light", art: "assets/artwork.png", palette: { canvas: "#ffffff", text: "#000000", accent: "#3366ff" } }),
		);
		mkdirSync(join(source, "assets"));
		writeFileSync(join(source, "assets", "artwork.png"), Buffer.from(PNG, "base64"));
		const theme = lib.installDirectory(source);
		expect(theme.id).toBe("extracted");
		expect(existsSync(join(lib.dir, "extracted", "theme.json"))).toBe(true);
		expect(lib.snapshot().themes[0]?.art).toBe(true);
	});

	test("rejects an extracted theme folder without its manifest", () => {
		const lib = library();
		const source = join(base, "not-a-theme");
		mkdirSync(source, { recursive: true });
		expect(() => lib.installDirectory(source)).toThrow("theme.json");
	});

	test("reinstalling replaces the theme", () => {
		const lib = library();
		lib.install(themePackage("snow", "#111111"));
		lib.install(themePackage("snow", "#222222"));
		expect(lib.snapshot().themes[0]?.colors.accent).toBe("#222222");
	});

	test("finds artwork where the codexthemes installer leaves it", () => {
		const lib = library();
		mkdirSync(join(lib.dir, "copied"), { recursive: true });
		writeFileSync(
			join(lib.dir, "copied", "theme.json"),
			JSON.stringify({ id: "copied", art: "assets/artwork.png", palette: { canvas: "#ffffff", text: "#000000", accent: "#3366ff" } }),
		);
		writeFileSync(join(lib.dir, "copied", "artwork.png"), Buffer.from(PNG, "base64"));
		expect(lib.snapshot().themes[0]?.art).toBe(true);
		expect(lib.art("copied")).toStartWith("data:image/png;base64,");
	});

	test("installs a dropped package and removes it", () => {
		const lib = library();
		const path = drop(lib.dir, "drop-me.codex-theme", themePackage("drop-me"));
		expect(lib.processDropped()).toEqual({ installed: ["drop-me"], pending: false });
		expect(existsSync(path)).toBe(false);
		expect(lib.snapshot().themes.map((entry) => entry.id)).toEqual(["drop-me"]);
	});

	test("a broken package is set aside with the reason beside it", () => {
		const lib = library();
		const path = drop(lib.dir, "broken.codex-theme", "{ not json");
		expect(lib.processDropped().installed).toEqual([]);
		expect(existsSync(`${path}.failed`)).toBe(true);
		expect(readFileSync(`${path}.error.txt`, "utf8")).toContain("不是 JSON");
		// Not retried on the next pass.
		expect(lib.processDropped().installed).toEqual([]);
	});

	test("leaves a package alone while it may still be downloading", () => {
		const lib = library();
		mkdirSync(lib.dir, { recursive: true });
		writeFileSync(join(lib.dir, "fresh.codex-theme"), '{"format":"codex-th');
		expect(lib.processDropped()).toEqual({ installed: [], pending: true });
		expect(existsSync(join(lib.dir, "fresh.codex-theme"))).toBe(true);
	});

	test("removing sends the folder to the trash", async () => {
		const lib = library() as ThemeLibrary & { trashed: string[] };
		lib.install(themePackage("gone"));
		const snapshot = await lib.remove("gone");
		expect(snapshot.themes).toEqual([]);
		expect(lib.trashed).toEqual([join(lib.dir, "gone")]);
		await expect(lib.remove("../outside")).rejects.toThrow("id 无效");
	});
});
