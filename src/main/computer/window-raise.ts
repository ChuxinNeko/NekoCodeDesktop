import type { ComputerCallResult } from "./protocol";

/**
 * Bring a window above the others without giving it the keyboard.
 *
 * Runs in the Computer Use worker, next to the other native code. The driver's
 * own `bring_to_front` activates the window, which takes focus from wherever
 * the user is typing — usually NekoCode itself. Here the window is only moved
 * in the z-order: made topmost and at once not, which leaves it at the top of
 * the ordinary windows, with SWP_NOACTIVATE throughout. A minimized window is
 * restored the same way, without activation.
 */

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SW_SHOWNOACTIVATE = 4;

interface User32 {
	SetWindowPos(hwnd: number, after: number, x: number, y: number, cx: number, cy: number, flags: number): boolean;
	IsWindow(hwnd: number): boolean;
	IsIconic(hwnd: number): boolean;
	ShowWindow(hwnd: number, command: number): boolean;
}

let user32: User32 | null = null;

function load(): User32 {
	if (user32) return user32;
	// Loaded on first use: a worker that never raises a window never maps it.
	const koffi = require("koffi") as typeof import("koffi");
	const lib = koffi.load("user32.dll");
	user32 = {
		SetWindowPos: lib.func(
			"bool __stdcall SetWindowPos(intptr hWnd, intptr after, int x, int y, int cx, int cy, uint flags)",
		),
		IsWindow: lib.func("bool __stdcall IsWindow(intptr hWnd)"),
		IsIconic: lib.func("bool __stdcall IsIconic(intptr hWnd)"),
		ShowWindow: lib.func("bool __stdcall ShowWindow(intptr hWnd, int cmd)"),
	};
	return user32;
}

export function raiseWindow(args: Record<string, unknown>): ComputerCallResult {
	const hwnd = args.window_id;
	if (process.platform !== "win32") return failed("Raising windows is only supported on Windows.");
	if (typeof hwnd !== "number" || !Number.isSafeInteger(hwnd) || hwnd <= 0) return failed("window_id is required.");
	const api = load();
	if (!api.IsWindow(hwnd)) return failed(`Window ${hwnd} no longer exists.`);
	if (api.IsIconic(hwnd)) api.ShowWindow(hwnd, SW_SHOWNOACTIVATE);
	const flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW;
	const raised = api.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
	const released = api.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
	// A window left topmost would sit over everything until it closed.
	if (raised && !released) return failed(`Window ${hwnd} was raised but could not be returned to normal stacking.`);
	if (!raised) return failed(`Window ${hwnd} could not be raised.`);
	return { text: `Raised window ${hwnd}.`, images: [], isError: false };
}

function failed(text: string): ComputerCallResult {
	return { text, images: [], isError: true };
}
