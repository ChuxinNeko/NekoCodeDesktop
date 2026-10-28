import { describe, expect, test } from "bun:test";
import { BackgroundMode } from "../../src/main/background-mode";

function setup() {
	const calls: string[] = [];
	let visible = true;
	let minimized = false;
	let destroyed = false;
	let trayFails = false;
	let actions: { show(): void; quit(): void } | undefined;
	const window = {
		isDestroyed: () => destroyed,
		isVisible: () => visible,
		isMinimized: () => minimized,
		hide: () => { visible = false; calls.push("hide"); },
		minimize: () => { minimized = true; calls.push("minimize"); },
		restore: () => { minimized = false; calls.push("restore"); },
		show: () => { visible = true; calls.push("show"); },
		focus: () => { calls.push("focus"); },
	};
	const mode = new BackgroundMode({
		getWindow: () => window,
		createWindow: () => { calls.push("createWindow"); },
		createTray: (next) => {
			calls.push("createTray");
			if (trayFails) throw new Error("No system tray");
			actions = next;
			return { destroy: () => { calls.push("destroyTray"); } };
		},
		quit: () => {
			calls.push("quit");
			// app.quit closes windows again; that close must not be intercepted.
			mode.handleClose({ preventDefault: () => { calls.push("blockedQuit"); } });
		},
		onTrayError: () => { calls.push("trayError"); },
	});
	return {
		mode, window, calls, actions: () => actions!,
		close: () => mode.handleClose({ preventDefault: () => { calls.push("preventClose"); } }),
		setTrayFails: (value: boolean) => { trayFails = value; },
		setDestroyed: () => { destroyed = true; },
	};
}

describe("background window lifecycle", () => {
	test("hands the tray to root and restores it when returning without marking the user session as quitting", () => {
		const app = setup();
		app.mode.loadBehavior("tray");
		app.mode.suspendTray();
		app.window.hide();
		app.mode.loadBehavior("tray");
		app.mode.showWindow();
		expect(app.calls).toEqual(["createTray", "destroyTray", "hide", "createTray", "show", "focus"]);
		app.close();
		expect(app.calls.slice(-2)).toEqual(["preventClose", "hide"]);
	});
	test("quit behavior closes instead of hiding, without intercepting the final close", () => {
		const app = setup();
		app.mode.setBehavior("quit");
		app.close();
		expect(app.calls).toEqual(["quit"]);
		app.mode.requestQuit();
		expect(app.calls).toEqual(["quit"]);
	});

	test("close to tray hides the existing window, retaining its services and a recovery entry", () => {
		const app = setup();
		app.mode.setBehavior("tray");
		app.close();
		app.close();
		expect(app.calls).toEqual(["createTray", "preventClose", "hide", "preventClose", "hide"]);
		expect(app.window.isVisible()).toBe(false);
		app.actions().show();
		expect(app.calls.slice(-2)).toEqual(["show", "focus"]);
		expect(app.window.isVisible()).toBe(true);
	});

	test("tray Quit destroys the icon and bypasses close-to-tray exactly once", () => {
		const app = setup();
		app.mode.setBehavior("tray");
		app.close();
		app.actions().quit();
		expect(app.calls.slice(-2)).toEqual(["destroyTray", "quit"]);
		expect(app.calls).not.toContain("blockedQuit");
		app.actions().quit();
		expect(app.calls.filter((call) => call === "quit")).toHaveLength(1);
	});

	test("explicit quit, updater restart and system shutdown do not hide windows", () => {
		const app = setup();
		app.mode.setBehavior("tray");
		app.mode.beginQuit();
		app.close();
		expect(app.calls).toEqual(["createTray", "destroyTray"]);
		app.mode.showWindow();
		expect(app.calls).not.toContain("createWindow");
	});

	test("disabling tray mode reveals a hidden window before removing its tray entry", () => {
		const app = setup();
		app.mode.setBehavior("tray");
		app.close();
		app.mode.setBehavior("quit");
		expect(app.calls.slice(-3)).toEqual(["show", "focus", "destroyTray"]);
		app.close();
		expect(app.calls.at(-1)).toBe("quit");
	});

	test("startup without tray support minimizes to the taskbar instead of stranding the window", () => {
		const app = setup();
		app.setTrayFails(true);
		app.mode.loadBehavior("tray");
		app.close();
		expect(app.calls).toContain("minimize");
		expect(app.calls).not.toContain("hide");
		expect(app.calls).not.toContain("quit");
		app.mode.showWindow();
		expect(app.calls.slice(-3)).toEqual(["restore", "show", "focus"]);
	});

	test("a failed tray preference preparation preserves the previous close behavior", () => {
		const app = setup();
		app.setTrayFails(true);
		expect(() => app.mode.setBehavior("tray")).toThrow("No system tray");
		app.close();
		expect(app.calls.at(-1)).toBe("quit");
	});

	test("activate/second launch restores a minimized window or recreates a destroyed one", () => {
		const app = setup();
		app.window.minimize();
		app.mode.showWindow();
		expect(app.calls.slice(-3)).toEqual(["restore", "show", "focus"]);
		app.setDestroyed();
		app.mode.showWindow();
		expect(app.calls.at(-1)).toBe("createWindow");
	});
});
