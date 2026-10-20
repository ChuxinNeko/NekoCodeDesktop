import type { BrowserWindow, Screen } from "electron";
import { resolveDisplayScale } from "../shared/display-scale";

/** Return a refresh callback so preference changes use the same path as display changes. */
export function installDisplayScale(win: BrowserWindow, preference: () => number | null, onScale: (scale: number) => void,
	displays: Pick<Screen, "getDisplayMatching" | "on" | "off">): () => void {
	let lastScale: number | undefined;
	let restoreTimer: ReturnType<typeof setTimeout> | undefined;
	const contents = win.webContents;
	const refresh = () => {
		if (win.isDestroyed() || contents.isDestroyed() || win.isMinimized()) return;
		const bounds = win.getBounds();
		const [width, height] = win.getContentSize();
		const [minWidth, minHeight] = win.getMinimumSize();
		// Windows can report its minimized rectangle during move/resize before
		// isMinimized() changes. Never use that transient geometry as app zoom.
		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
			|| bounds.width < minWidth || bounds.height < minHeight) return;
		const display = displays.getDisplayMatching(bounds);
		const scale = resolveDisplayScale(display.bounds, { width, height }, preference());
		if (Math.abs(contents.getZoomFactor() - scale) > 0.001) contents.setZoomFactor(scale);
		if (scale !== lastScale) {
			lastScale = scale;
			onScale(scale);
		}
	};
	const restored = () => {
		refresh();
		// A native restore/show event can precede the final content bounds.
		// Recheck on the next turn without waiting for a user-initiated resize.
		clearTimeout(restoreTimer);
		restoreTimer = setTimeout(refresh, 0);
	};
	win.on("resize", refresh);
	win.on("move", refresh);
	win.on("restore", restored);
	win.on("show", restored);
	contents.on("did-finish-load", refresh);
	displays.on("display-metrics-changed", refresh);
	displays.on("display-added", refresh);
	displays.on("display-removed", refresh);
	win.once("closed", () => {
		clearTimeout(restoreTimer);
		win.off("resize", refresh);
		win.off("move", refresh);
		win.off("restore", restored);
		win.off("show", restored);
		contents.off("did-finish-load", refresh);
		displays.off("display-metrics-changed", refresh);
		displays.off("display-added", refresh);
		displays.off("display-removed", refresh);
	});
	refresh();
	return refresh;
}
