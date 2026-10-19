import { screen, type BrowserWindow } from "electron";
import { resolveDisplayScale } from "../shared/display-scale";

/** Return a refresh callback so preference changes use the same path as display changes. */
export function installDisplayScale(win: BrowserWindow, preference: () => number | null, onScale: (scale: number) => void): () => void {
	let lastScale: number | undefined;
	const refresh = () => {
		if (win.isDestroyed()) return;
		const display = screen.getDisplayMatching(win.getBounds());
		const [width, height] = win.getContentSize();
		const scale = resolveDisplayScale(display.bounds, { width, height }, preference());
		if (Math.abs(win.webContents.getZoomFactor() - scale) > 0.001) win.webContents.setZoomFactor(scale);
		if (scale !== lastScale) {
			lastScale = scale;
			onScale(scale);
		}
	};
	win.on("resize", refresh);
	win.on("move", refresh);
	win.webContents.on("did-finish-load", refresh);
	screen.on("display-metrics-changed", refresh);
	screen.on("display-added", refresh);
	screen.on("display-removed", refresh);
	win.once("closed", () => {
		screen.off("display-metrics-changed", refresh);
		screen.off("display-added", refresh);
		screen.off("display-removed", refresh);
	});
	refresh();
	return refresh;
}
