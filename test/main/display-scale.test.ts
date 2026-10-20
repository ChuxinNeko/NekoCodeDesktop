import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow, Screen } from "electron";
import { installDisplayScale } from "../../src/main/display-scale";

function harness() {
	const state = {
		minimized: false, destroyed: false, contentsDestroyed: false, zoom: 1,
		percent: null as number | null,
		bounds: { x: 0, y: 0, width: 1600, height: 1040 },
		content: [1600, 1000], display: { width: 3840, height: 2160 },
	};
	const applied: number[] = [];
	const announced: number[] = [];
	const contents = Object.assign(new EventEmitter(), {
		isDestroyed: () => state.contentsDestroyed,
		getZoomFactor: () => state.zoom,
		setZoomFactor: (scale: number) => { state.zoom = scale; applied.push(scale); },
	});
	const win = Object.assign(new EventEmitter(), {
		webContents: contents,
		isDestroyed: () => state.destroyed,
		isMinimized: () => state.minimized,
		getBounds: () => state.bounds,
		getContentSize: () => state.content,
		getMinimumSize: () => [800, 560],
	});
	const displays = Object.assign(new EventEmitter(), { getDisplayMatching: () => ({ bounds: state.display }) });
	const refresh = installDisplayScale(win as unknown as BrowserWindow, () => state.percent,
		scale => announced.push(scale), displays as unknown as Screen);
	return { state, applied, announced, contents, win, displays, refresh };
}

test("minimized resize/move/display events preserve the last usable zoom", () => {
	const h = harness();
	expect(h.state.zoom).toBe(1.56);
	h.state.minimized = true;
	h.state.content = [0, 0];
	h.state.bounds = { x: -32000, y: -32000, width: 160, height: 30 };
	h.win.emit("resize");
	h.win.emit("move");
	h.displays.emit("display-metrics-changed");
	expect(h.applied).toEqual([1.56]);
	expect(h.announced).toEqual([1.56]);
});

test("transient minimized geometry is ignored even before the minimized flag changes", () => {
	const h = harness();
	h.state.content = [160, 30];
	h.state.bounds = { x: -32000, y: -32000, width: 160, height: 30 };
	h.win.emit("resize");
	expect(h.applied).toEqual([1.56]);
	h.state.bounds = { x: 0, y: 0, width: 1600, height: 1040 };
	for (const content of [[0, 1000], [1600, 0], [NaN, 1000]]) {
		h.state.content = content;
		h.refresh();
	}
	expect(h.applied).toEqual([1.56]);
});

test("restoring a window repairs zoom without requiring a resize", async () => {
	const h = harness();
	h.state.zoom = 0.75;
	h.win.emit("restore");
	expect(h.state.zoom).toBe(1.56);
	await new Promise(resolve => setTimeout(resolve, 5));
	// The deferred refresh is idempotent and does not repeatedly write zoom.
	expect(h.applied).toEqual([1.56, 1.56]);
	expect(h.announced).toEqual([1.56]);
});

test("restore checks again after native content bounds have settled", async () => {
	const h = harness();
	h.state.zoom = 0.75;
	h.state.content = [0, 0];
	h.win.emit("restore");
	expect(h.state.zoom).toBe(0.75);
	h.state.content = [1600, 1000];
	await new Promise(resolve => setTimeout(resolve, 5));
	expect(h.state.zoom).toBe(1.56);
});

test("a manual percentage updated while minimized is applied on restore", async () => {
	const h = harness();
	h.state.minimized = true;
	h.state.percent = 125;
	h.refresh();
	expect(h.state.zoom).toBe(1.56);
	h.state.minimized = false;
	h.win.emit("restore");
	await new Promise(resolve => setTimeout(resolve, 5));
	expect(h.state.zoom).toBe(1.25);
	expect(h.state.percent).toBe(125);
});

test("showing a hidden window uses the current monitor and automatic sizing still follows real resizes", async () => {
	const h = harness();
	h.state.display = { width: 1920, height: 1080 };
	h.win.emit("show");
	await new Promise(resolve => setTimeout(resolve, 5));
	expect(h.state.zoom).toBe(1);
	h.state.bounds = { x: 0, y: 0, width: 920, height: 640 };
	h.state.content = [920, 600];
	h.win.emit("resize");
	expect(h.state.zoom).toBe(0.92);
});

test("closing cancels deferred restore work and releases event listeners", async () => {
	const h = harness();
	h.win.emit("restore");
	h.state.destroyed = true;
	h.win.emit("closed");
	h.state.zoom = 0.75;
	h.refresh();
	await new Promise(resolve => setTimeout(resolve, 5));
	expect(h.state.zoom).toBe(0.75);
	for (const event of ["display-metrics-changed", "display-added", "display-removed"]) expect(h.displays.listenerCount(event)).toBe(0);
	for (const event of ["resize", "move", "restore", "show"]) expect(h.win.listenerCount(event)).toBe(0);
	expect(h.contents.listenerCount("did-finish-load")).toBe(0);
});
