/**
 * Steam / Wallpaper Engine install discovery.
 *
 * Same order as the wallpaper-engine host this was taken from: an explicit
 * root override, then the HKCU SteamPath registry value, then the usual
 * install directories, then (on WSL) `/mnt/<letter>`. A directory counts as
 * the install root when a marker exists at the root or under `distribution\`.
 * A Steam library counts only when `steamapps/workshop/content/431960` exists.
 */
import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { WALLPAPER_ENGINE_APP_ID } from "../../shared/wallpaper";

const STEAM_PROBE_DIRS = [
	"C:\\Program Files (x86)\\Steam",
	"C:\\Program Files\\Steam",
	"D:\\Steam",
	"D:\\SteamLibrary",
	"E:\\SteamLibrary",
];

const WE_INSTALL_MARKERS = [
	"wallpaper32.exe",
	"wallpaper64.exe",
	join("distribution", "wallpaper32.exe"),
	join("distribution", "wallpaper64.exe"),
	join("distribution", "version.json"),
];

const STEAM_PROBE_TTL_MS = 60_000;

async function pathExists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

/** Windows path (`D:\Steam`) to a WSL mount (`/mnt/d/Steam`). No-op elsewhere. */
export function wslPath(value: string): string {
	if (process.platform !== "linux") return value;
	const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value);
	if (!match) return value;
	const rest = match[2] ?? "";
	return join("/mnt", match[1]!.toLowerCase(), rest.replace(/\\/g, "/"));
}

/**
 * Libraries named in a `libraryfolders.vdf`. A path is kept only when a later
 * line in that library block mentions the Wallpaper Engine app id.
 */
export function librariesFromVdfText(text: string, appId: string = WALLPAPER_ENGINE_APP_ID): string[] {
	const libs: string[] = [];
	let current: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*"path"\s+"([^"]+)"\s*$/.exec(line);
		if (match?.[1]) {
			current = match[1].replace(/\\\\/g, "\\");
			continue;
		}
		if (current && line.includes(appId)) {
			const mapped = wslPath(current);
			if (mapped && !libs.includes(mapped)) libs.push(mapped);
		}
	}
	return libs;
}

function steamRootsFromEnv(): string[] {
	const raw = (process.env.NEKOCODE_WE_STEAM_ROOT || process.env.DSH_WE_STEAM_ROOT || "").trim();
	if (!raw) return [];
	return raw
		.split(/[,;]/)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map(wslPath);
}

async function resolveRegExe(): Promise<string | null> {
	if (process.platform === "win32") return join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
	if (process.platform !== "linux") return null;
	let letters: string[];
	try {
		letters = (await readdir("/mnt")).filter((name) => /^[a-zA-Z]$/.test(name));
	} catch {
		return null;
	}
	for (const letter of letters) {
		const candidate = join("/mnt", letter, "Windows", "System32", "reg.exe");
		if (await pathExists(candidate)) return candidate;
	}
	return null;
}

function steamPathFromRegistry(): Promise<string | null> {
	return resolveRegExe().then((reg) => {
		if (!reg) return null;
		return new Promise((resolve) => {
			try {
				execFile(reg, ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { encoding: "utf8", windowsHide: true, timeout: 5000 }, (error, stdout) => {
					if (error) {
						resolve(null);
						return;
					}
					const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout || "");
					const found = match?.[1] ? normalize(match[1].trim()) : null;
					resolve(found ? wslPath(found) : null);
				});
			} catch {
				resolve(null);
			}
		});
	});
}

async function wslSteamRoots(): Promise<string[]> {
	if (process.platform !== "linux") return [];
	let letters: string[];
	try {
		letters = (await readdir("/mnt")).filter((name) => /^[a-zA-Z]$/.test(name));
	} catch {
		return [];
	}
	const roots: string[] = [];
	for (const letter of letters) {
		const base = join("/mnt", letter);
		for (const candidate of [
			join(base, "Program Files (x86)", "Steam"),
			join(base, "Program Files", "Steam"),
			join(base, "Steam"),
			join(base, "SteamLibrary"),
		]) {
			if (await pathExists(join(candidate, "steamapps", "libraryfolders.vdf"))) roots.push(candidate);
		}
	}
	return roots;
}

let steamProbeCache: { at: number; key: string; dirs: string[] } | null = null;
let steamProbeInflight: Promise<string[]> | null = null;

async function steamProbeDirs(): Promise<string[]> {
	const envKey = `${process.env.NEKOCODE_WE_STEAM_ROOT || ""}|${process.env.DSH_WE_STEAM_ROOT || ""}`;
	if (steamProbeCache && steamProbeCache.key === envKey && Date.now() - steamProbeCache.at < STEAM_PROBE_TTL_MS) {
		return steamProbeCache.dirs;
	}
	if (steamProbeInflight) return steamProbeInflight;
	steamProbeInflight = (async () => {
		const env = steamRootsFromEnv();
		const reg = await steamPathFromRegistry();
		const wsl = await wslSteamRoots();
		return [...env, ...(reg ? [reg] : []), ...STEAM_PROBE_DIRS, ...wsl];
	})();
	try {
		const dirs = await steamProbeInflight;
		steamProbeCache = { at: Date.now(), key: envKey, dirs };
		return dirs;
	} finally {
		steamProbeInflight = null;
	}
}

async function isWallpaperEngineRoot(dir: string): Promise<boolean> {
	for (const marker of WE_INSTALL_MARKERS) {
		if (await pathExists(join(dir, marker))) return true;
	}
	return false;
}

/** Install root that holds `projects\` and `config.json`, or null. */
export async function locateWallpaperEngine(): Promise<string | null> {
	const probes = await steamProbeDirs();
	const libraries: string[] = [];
	for (const probe of probes) {
		const vdf = join(probe, "steamapps", "libraryfolders.vdf");
		if (!(await pathExists(vdf))) continue;
		try {
			libraries.push(...librariesFromVdfText(await readFile(vdf, "utf8")));
		} catch {
			// A broken library list does not hide the other roots.
		}
	}
	const candidates: string[] = [];
	for (const root of [...probes, ...libraries]) candidates.push(join(root, "steamapps", "common", "wallpaper_engine"));
	candidates.push(wslPath("C:\\Program Files (x86)\\Wallpaper Engine"));
	const seen = new Set<string>();
	for (const raw of candidates) {
		const dir = normalize(raw);
		if (seen.has(dir)) continue;
		seen.add(dir);
		if (await isWallpaperEngineRoot(dir)) return dir;
	}
	return null;
}

/** Steam libraries whose workshop folder actually contains Wallpaper Engine items. */
export async function owningLibraries(): Promise<string[]> {
	const libs: string[] = [];
	for (const probe of await steamProbeDirs()) {
		const vdf = join(probe, "steamapps", "libraryfolders.vdf");
		if (await pathExists(vdf)) {
			try {
				libs.push(...librariesFromVdfText(await readFile(vdf, "utf8")));
			} catch {
				// skip this library list
			}
		}
		if (await pathExists(join(probe, "steamapps", "workshop", "content", WALLPAPER_ENGINE_APP_ID))) libs.push(probe);
	}
	return [...new Set(libs)];
}
