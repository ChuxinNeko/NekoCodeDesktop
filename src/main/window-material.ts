import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { DEFAULT_WINDOW_MATERIAL, isWindowMaterial, type WindowMaterial } from "../shared/window";

/**
 * Windows 11 22H2 is the first build whose DWM understands the system backdrop
 * types Electron's `backgroundMaterial` maps onto. On 21H2 (build 22000) and
 * earlier — every Windows 10 release included — `DwmSetWindowAttribute` rejects
 * the attribute and the window would paint its (transparent) background over
 * nothing, which reads as a blank window.
 */
const WINDOWS_BACKDROP_MIN_BUILD = 22621;

/**
 * The build number of the running Windows, or 0 anywhere else. `release()` is
 * shaped `<major>.<minor>.<build>`; the third field is the one the backdrop
 * APIs are gated on.
 */
export function windowsBuildNumber(version: string = release()): number {
	const build = Number.parseInt(version.split(".")[2] ?? "", 10);
	return Number.isFinite(build) ? build : 0;
}

/**
 * Whether this machine can composite a system backdrop at all. Non-Windows
 * platforms are excluded here: macOS gets its vibrancy from the window itself
 * (see `theme.logic.ts`), and Linux has no equivalent to fall back to.
 */
export function supportsSystemBackdrops(
	platform: string,
	build: number = windowsBuildNumber(),
): boolean {
	return platform === "win32" && build >= WINDOWS_BACKDROP_MIN_BUILD;
}

/**
 * Every material the appearance picker may offer on this machine, `opaque`
 * first. The picker greys out the rest, so a Windows 10 user is never handed a
 * choice that would leave them with a window they cannot see.
 */
export function supportedWindowMaterials(
	platform: string = process.platform,
	build: number = windowsBuildNumber(),
): WindowMaterial[] {
	return supportsSystemBackdrops(platform, build) ? ["opaque", "mica", "acrylic"] : ["opaque"];
}

/** The subset of `BrowserWindow` this module drives, so tests can stand in a fake. */
export interface WindowMaterialTarget {
	isDestroyed(): boolean;
	setBackgroundMaterial(material: "none" | "mica" | "acrylic"): void;
	setBackgroundColor(color: string): void;
}

/**
 * Hand a window a new system material.
 *
 * Two things have to move together: the DWM backdrop itself, and the window's
 * own background. A backdrop is composited *behind* the window, so the window
 * must paint nothing at all for it to show — and must paint a solid color again
 * the moment the backdrop goes away, or it would sit over the desktop.
 *
 * Every step is guarded: the backdrop call is unsupported (and throws) below
 * Windows 11 22H2, and a window can be destroyed between the user's click and
 * this running. Neither is worth failing a settings change over — the window
 * just stays opaque.
 */
export function applyWindowMaterial(
	target: WindowMaterialTarget,
	material: WindowMaterial,
	opaqueColor: string,
	platform: string = process.platform,
): void {
	if (platform !== "win32" || target.isDestroyed()) return;

	if (material !== "opaque" && supportsSystemBackdrops(platform)) {
		try {
			target.setBackgroundMaterial(material);
			target.setBackgroundColor("#00000000");
			return;
		} catch {
			// A build that rejected the backdrop despite reporting support falls
			// through to the opaque shell rather than leaving a transparent window.
		}
	}

	try {
		target.setBackgroundMaterial("none");
	} catch {
		// Below 22H2 there is no material to turn off.
	}
	target.setBackgroundColor(opaqueColor);
}

interface StoredPreference {
	material?: unknown;
}

/**
 * Remembers which material the user picked.
 *
 * Kept beside the other main-process preferences (`proxy.json`) rather than in
 * the renderer's theme state: the window is created long before the renderer
 * runs, and it needs the material already resolved so the first paint is not a
 * flash of the wrong shell.
 */
export class WindowMaterialStore {
	private readonly filePath: string;
	private preference: WindowMaterial | null | undefined;

	constructor(userDataDir: string) {
		this.filePath = join(userDataDir, "window-material.json");
	}

	/** The stored choice, or `null` when the user has never made one. */
	load(): WindowMaterial | null {
		if (this.preference !== undefined) return this.preference;
		this.preference = this.read();
		return this.preference;
	}

	private read(): WindowMaterial | null {
		if (!existsSync(this.filePath)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
			const material = (parsed as StoredPreference | null)?.material;
			return isWindowMaterial(material) ? material : null;
		} catch {
			// A damaged file costs the preference, not the app.
			return null;
		}
	}

	/** `null` hands the choice back to the default. */
	save(material: WindowMaterial | null): void {
		mkdirSync(join(this.filePath, ".."), { recursive: true });
		const tmp = `${this.filePath}.tmp-${process.pid}`;
		try {
			writeFileSync(tmp, `${JSON.stringify({ material }, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// best-effort cleanup of our own temp file
			}
			throw error;
		}
		this.preference = material;
	}

	/**
	 * The material to open the window with: the stored pick when this machine
	 * can render it, and the opaque shell otherwise. A preference saved on
	 * another machine (or before a downgrade) is never applied blind.
	 */
	resolve(supported: readonly WindowMaterial[]): WindowMaterial {
		const preferred = this.load() ?? DEFAULT_WINDOW_MATERIAL;
		return supported.includes(preferred) ? preferred : "opaque";
	}
}
