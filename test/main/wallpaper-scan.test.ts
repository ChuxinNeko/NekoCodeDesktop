import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { librariesFromVdfText } from "../../src/main/wallpaper/discover";
import { enumerateWallpapers, schemeToCss } from "../../src/main/wallpaper/scan";
import { buildSeedScript } from "../../src/main/wallpaper/we-props";

describe("wallpaper engine discovery", () => {
	test("libraryfolders.vdf keeps only libraries that mention app 431960", () => {
		const text = `
"libraryfolders"
{
  "0"
  {
    "path" "D:\\\\SteamLibrary"
    "apps"
    {
      "431960" "1"
    }
  }
  "1"
  {
    "path" "E:\\\\Other"
  }
}
`;
		expect(librariesFromVdfText(text)).toEqual(["D:\\SteamLibrary"]);
	});

	test("scheme color converts Wallpaper Engine's 0–1 triple", () => {
		expect(schemeToCss("1 0 0.5")).toBe("rgb(255, 0, 128)");
		expect(schemeToCss("nope")).toBeNull();
	});

	test("web property seed keeps declared values and skips non-editable ones", () => {
		const script = buildSeedScript(
			{
				file: "index.html",
				general: {
					properties: {
						schemecolor: { type: "color", value: "0.2 0.3 0.4", order: 1 },
						hidden: { type: "bool", value: true, editable: false },
					},
				},
			},
			"index.html",
		);
		expect(script).toContain("__weSeedProps");
		expect(script).toContain("schemecolor");
		expect(script).not.toContain("hidden");
	});

	test("scan reads my projects and workshop items, and scene.json falls back to scene.pkg", async () => {
		const root = await mkdtemp(join(tmpdir(), "neko-wallpaper-"));
		const install = join(root, "wallpaper_engine");
		const project = join(install, "projects", "myprojects", "Alpha");
		await mkdir(project, { recursive: true });
		await writeFile(
			join(project, "project.json"),
			JSON.stringify({ title: "Alpha", type: "video", file: "clip.mp4", preview: "preview.jpg", contentrating: "Everyone" }),
		);
		await writeFile(join(project, "clip.mp4"), "");
		await writeFile(join(project, "preview.jpg"), "");

		const library = join(root, "SteamLibrary");
		const scene = join(library, "steamapps", "workshop", "content", "431960", "999");
		await mkdir(scene, { recursive: true });
		await writeFile(join(scene, "project.json"), JSON.stringify({ title: "Scene", type: "scene", file: "scene.json" }));
		await writeFile(join(scene, "scene.pkg"), "");

		const found = await enumerateWallpapers(install, [library]);
		const alpha = found.find((entry) => entry.id === "Alpha");
		const workshop = found.find((entry) => entry.id === "999");
		expect(alpha?.type).toBe("video");
		expect(alpha?.title).toBe("Alpha");
		expect(alpha?.previewAbs?.endsWith("preview.jpg")).toBe(true);
		expect(workshop?.file).toBe("scene.pkg");
		expect(workshop?.type).toBe("scene");
	});
});
