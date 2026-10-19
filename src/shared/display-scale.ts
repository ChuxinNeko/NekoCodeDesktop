/** Additional app zoom. Display sizes are DIPs: the OS has already applied DPI scaling. */
export const UI_SCALE_OPTIONS = [75, 90, 100, 110, 125, 150, 175, 200] as const;

export function isUiScalePercent(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 75 && value <= 200);
}

export interface DisplaySize { width: number; height: number }

export function automaticDisplayScale(display: DisplaySize): number {
	// Short edge also handles portrait and ultrawide screens without over-scaling.
	return Math.min(2, Math.max(1, Math.min(display.width, display.height) / 1080));
}

export function resolveDisplayScale(display: DisplaySize, content: DisplaySize, percent: number | null): number {
	if (percent !== null && isUiScalePercent(percent)) return percent / 100;
	// A restored / small window needs room for navigation and the main content.
	const fit = Math.min(content.width / 1000, content.height / 640);
	return Math.round(Math.max(0.75, Math.min(automaticDisplayScale(display), fit)) * 100) / 100;
}

export function initialWindowSize(workArea: DisplaySize, display: DisplaySize) {
	const scale = automaticDisplayScale(display);
	return {
		width: Math.min(workArea.width, Math.round(1267 * scale)),
		height: Math.min(workArea.height, Math.round(792 * scale)),
		minWidth: Math.min(800, workArea.width),
		minHeight: Math.min(560, workArea.height),
	};
}
