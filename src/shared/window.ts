/**
 * Window chrome contract between the main process and the renderer.
 *
 * The app draws its own caption strip (see `TitleBar`), so the renderer has to
 * know how tall that strip is and which system material backs the window — the
 * latter decides whether the shell paints an opaque background or lets the
 * material show through.
 */

/**
 * Height of the app-drawn caption strip, in CSS pixels. Main passes this to
 * `titleBarOverlay` so the system-drawn caption buttons are exactly as tall as
 * the row the renderer reserves for them.
 */
export const TITLE_BAR_HEIGHT = 40;

/**
 * System material composited behind the window by the OS.
 *
 * `opaque` is the plain shell the app paints itself and is the one material
 * every platform can render; `mica` and `acrylic` are the Windows 11 system
 * backdrops (macOS maps both onto its single vibrancy material).
 */
export type WindowMaterial = "opaque" | "mica" | "acrylic";

/** Every material, in the order the appearance picker lists them. */
export const WINDOW_MATERIALS: readonly WindowMaterial[] = ["opaque", "mica", "acrylic"];

/** What the picker selects before the user touches it. */
export const DEFAULT_WINDOW_MATERIAL: WindowMaterial = "mica";

export function isWindowMaterial(value: unknown): value is WindowMaterial {
	return typeof value === "string" && (WINDOW_MATERIALS as readonly string[]).includes(value);
}

export interface ShellInfo {
	/** The material the window is using right now. */
	material: WindowMaterial;
	/**
	 * Materials this machine can actually composite, `opaque` first. Windows
	 * before 11 22H2 (build 22621), Linux, and anything without a backdrop
	 * support the opaque shell only; the picker disables the rest rather than
	 * letting the user choose a material that would paint a blank window.
	 */
	materials: WindowMaterial[];
	titleBarHeight: number;
}

export const DEFAULT_SHELL_INFO: ShellInfo = {
	material: "opaque",
	materials: ["opaque"],
	titleBarHeight: TITLE_BAR_HEIGHT,
};
