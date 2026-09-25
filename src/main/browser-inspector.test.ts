import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { BrowserInspector } from "./browser-inspector";

function fakeGuest(id: number) {
	const guest = Object.assign(new EventEmitter(), {
		id,
		isDestroyed: () => false,
		debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
	});
	return guest as unknown as WebContents & EventEmitter;
}

function fakeWindow() {
	const webContents = { send: mock(() => undefined) };
	return { win: { isDestroyed: () => false, webContents } as unknown as BrowserWindow, webContents };
}

describe("BrowserInspector automation", () => {
	test("keeps each session's page separate", async () => {
		const { win, webContents } = fakeWindow();
		const inspector = new BrowserInspector(win);
		const first = fakeGuest(1);
		const second = fakeGuest(2);
		inspector.register(first);
		inspector.register(second);
		const a = inspector.automationHost("session-a");
		const b = inspector.automationHost("session-b");

		const boundA = a.requestAutomation("req-a", () => undefined);
		inspector.bindAutomation(webContents as never, "req-a", 1);
		const boundB = b.requestAutomation("req-b", () => undefined);
		inspector.bindAutomation(webContents as never, "req-b", 2);
		expect(await boundA).toBe(first);
		expect(await boundB).toBe(second);
		expect(a.automationGuest()).toBe(first);
		expect(b.automationGuest()).toBe(second);

		// Losing one session's page fails only that session's calls.
		const lostA = mock((_reason: string) => undefined);
		const lostB = mock((_reason: string) => undefined);
		a.watchAutomation(lostA);
		b.watchAutomation(lostB);
		first.emit("destroyed");
		expect(lostA).toHaveBeenCalledTimes(1);
		expect(lostB).not.toHaveBeenCalled();
		expect(() => a.automationGuest()).toThrow("No page is bound");
		expect(b.automationGuest()).toBe(second);
	});

	test("reveals the session's own page", async () => {
		const { win, webContents } = fakeWindow();
		const inspector = new BrowserInspector(win);
		inspector.register(fakeGuest(7));
		const host = inspector.automationHost("session-a");
		const bound = host.requestAutomation("req", () => undefined);
		inspector.bindAutomation(webContents as never, "req", 7);
		await bound;
		host.revealAutomation();
		expect(webContents.send).toHaveBeenCalledWith("browser:revealAutomation", { guestId: 7 });
	});
});
