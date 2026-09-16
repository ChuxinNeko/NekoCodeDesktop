/**
 * Window chrome contract between the main process and the renderer.
 *
 * The app draws its own caption strip (see `TitleBar`), so the renderer has to
 * know how tall that strip is and whether the window is backed by a system
 * material — the latter decides whether the shell paints an opaque background
 * or lets the material show through.
 */

/**
 * Height of the app-drawn caption strip, in CSS pixels. Main passes this to
 * `titleBarOverlay` so the system-drawn caption buttons are exactly as tall as
 * the row the renderer reserves for them.
 */
export const TITLE_BAR_HEIGHT = 40;

/** System material composited behind the window, when there is one. */
export type WindowBackdrop = "none" | "mica";

export interface ShellInfo {
	backdrop: WindowBackdrop;
	titleBarHeight: number;
}

export const DEFAULT_SHELL_INFO: ShellInfo = {
	backdrop: "none",
	titleBarHeight: TITLE_BAR_HEIGHT,
};
