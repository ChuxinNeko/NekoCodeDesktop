/**
 * Wallpaper Engine library scan: `projects/defaultprojects`, `projects/myprojects`,
 * and every `steamapps/workshop/content/431960` directory. A project is a folder
 * with `project.json`. Scene projects that declare `scene.json` but ship
 * `scene.pkg` (or the reverse) resolve to the file that is actually on disk.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { WALLPAPER_ENGINE_APP_ID, type WeWallpaperType } from "../../shared/wallpaper";

const KINDS: readonly WeWallpaperType[] = ["scene", "video", "web", "application"];
const SCAN_CHUNK = 24;
const PREVIEW_CANDIDATES = ["preview.jpg", "preview.png", "preview.gif", "preview.webp"];

export interface ScannedWallpaper {
	id: string;
	title: string;
	type: WeWallpaperType;
	file: string;
	fileAbs: string;
	previewAbs: string | null;
	dirAbs: string;
	contentrating: string | null;
	schemeColor: string | null;
	mediaExt: string;
}

export function schemeToCss(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const parts = value.trim().split(/\s+/).map(Number);
	if (parts.length < 3 || parts.slice(0, 3).some((channel) => !Number.isFinite(channel))) return null;
	const channels = parts.slice(0, 3).map((channel) => Math.max(0, Math.min(255, Math.round(channel * 255))));
	return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function inferType(file: string): WeWallpaperType {
	if (/\.(mp4|webm|mkv|avi|mov)$/i.test(file)) return "video";
	if (/\.(html?|js)$/i.test(file)) return "web";
	return "scene";
}

function mediaExt(file: string): string {
	const dot = file.lastIndexOf(".");
	const sepAt = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
	return dot > sepAt + 1 ? file.slice(dot + 1).toLowerCase() : "";
}

async function pathExists(target: string): Promise<boolean> {
	try {
		const info = await stat(target);
		return info.isFile() || info.isDirectory();
	} catch {
		return false;
	}
}

async function isFile(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isFile();
	} catch {
		return false;
	}
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isDirectory();
	} catch {
		return false;
	}
}

interface ProjectJson {
	title?: unknown;
	type?: unknown;
	file?: unknown;
	preview?: unknown;
	contentrating?: unknown;
	general?: { properties?: { schemecolor?: { value?: unknown } } };
}

function readProjectFields(dirName: string, project: ProjectJson): Omit<ScannedWallpaper, "fileAbs" | "previewAbs" | "dirAbs"> | null {
	if (typeof project.file !== "string" || !project.file.trim()) return null;
	const declared = typeof project.type === "string" ? project.type.toLowerCase() : inferType(project.file);
	const type = (KINDS as readonly string[]).includes(declared) ? (declared as WeWallpaperType) : "scene";
	const scheme = project.general?.properties?.schemecolor?.value;
	return {
		id: dirName,
		title: typeof project.title === "string" && project.title.trim() ? project.title : dirName,
		type,
		file: project.file,
		contentrating: typeof project.contentrating === "string" ? project.contentrating : null,
		schemeColor: schemeToCss(scheme),
		mediaExt: mediaExt(project.file),
	};
}

async function resolveSceneMainFile(dir: string, declared: string): Promise<string | null> {
	for (const candidate of [declared, "scene.pkg", "scene.json"]) {
		if (candidate && (await isFile(resolve(dir, candidate)))) return candidate;
	}
	let pkgs: string[];
	try {
		pkgs = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".pkg"));
	} catch {
		return null;
	}
	return pkgs.length === 1 ? (pkgs[0] ?? null) : null;
}

async function resolvePreview(dir: string, declared: string | null): Promise<string | null> {
	const candidates = declared ? [declared, ...PREVIEW_CANDIDATES] : PREVIEW_CANDIDATES;
	for (const candidate of candidates) {
		const abs = resolve(dir, candidate);
		if (await isFile(abs)) return abs;
	}
	return null;
}

async function readProject(dir: string): Promise<ScannedWallpaper | null> {
	const projectPath = join(dir, "project.json");
	if (!(await pathExists(projectPath))) return null;
	let parsed: ProjectJson;
	try {
		parsed = JSON.parse(await readFile(projectPath, "utf8")) as ProjectJson;
	} catch {
		return null;
	}
	const fields = readProjectFields(basename(dir), parsed);
	if (!fields) return null;
	const resolved = fields.type === "scene" ? ((await resolveSceneMainFile(dir, fields.file)) ?? fields.file) : fields.file;
	const fileAbs = resolve(dir, resolved);
	return {
		...fields,
		file: resolved,
		mediaExt: mediaExt(resolved),
		fileAbs,
		previewAbs: await resolvePreview(dir, typeof parsed.preview === "string" ? parsed.preview : null),
		dirAbs: dir,
	};
}

async function scanRoots(installDir: string | null, libraryDirs: readonly string[]): Promise<string[]> {
	const roots: string[] = [];
	if (installDir) {
		for (const sub of ["defaultprojects", "myprojects"]) {
			const dir = join(installDir, "projects", sub);
			if (await pathExists(dir)) roots.push(dir);
		}
	}
	for (const library of libraryDirs) {
		const workshop = join(library, "steamapps", "workshop", "content", WALLPAPER_ENGINE_APP_ID);
		if (await pathExists(workshop)) roots.push(workshop);
	}
	return roots;
}

export async function enumerateWallpapers(installDir: string | null, libraryDirs: readonly string[]): Promise<ScannedWallpaper[]> {
	const found = new Map<string, ScannedWallpaper>();
	const projectDirs: string[] = [];
	for (const root of await scanRoots(installDir, libraryDirs)) {
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const dir = join(root, entry);
			if (await isDirectory(dir)) projectDirs.push(dir);
		}
	}
	for (let index = 0; index < projectDirs.length; index += SCAN_CHUNK) {
		const chunk = projectDirs.slice(index, index + SCAN_CHUNK);
		const results = await Promise.all(chunk.map(async (dir) => readProject(dir)));
		for (const hit of results) {
			if (!hit || found.has(hit.id)) continue;
			found.set(hit.id, hit);
		}
	}
	return [...found.values()].sort((a, b) => a.title.localeCompare(b.title));
}
