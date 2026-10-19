import { describe, expect, test } from "bun:test";
import { performBrowserInput, type BrowserInputPage, type BrowserInputAction } from "../../src/main/browser-input";
import type { BrowserPointerUpdate } from "../../src/shared/browser";

function fixture() {
	const commands: { method: string; params?: Record<string, unknown> }[] = [];
	const pointers: BrowserPointerUpdate[] = [];
	let attached = false;
	let detaches = 0;
	const page: BrowserInputPage = {
		isDestroyed: () => false,
		executeJavaScript: async code => code.includes("const verifyTarget") ? true : ({ x: 180, y: 90, width: 800, height: 600, scrollY: 120 }),
		debugger: {
			isAttached: () => attached,
			attach: () => { attached = true; },
			detach: () => { attached = false; detaches++; },
			sendCommand: async (method, params) => { commands.push({ method, params }); },
		},
	};
	const controller = new AbortController();
	const run = (action: BrowserInputAction) => performBrowserInput(page, action, { signal: controller.signal, onPointer: update => pointers.push(update) });
	return { page, commands, pointers, controller, run, detaches: () => detaches };
}

describe("native browser input", () => {
	test("starts a later action at the previous pointer position", async () => {
		const f = fixture();
		await f.run({ action: "hover", selector: "button" });
		f.commands.length = 0;
		f.page.executeJavaScript = async code => code.includes("const verifyTarget") ? true : ({ x: 360, y: 180, width: 800, height: 600, scrollY: 120 });
		await f.run({ action: "click", selector: "button" });
		const first = f.commands.find(c => c.params?.type === "mouseMoved")!.params!;
		expect(first.x as number).toBeGreaterThan(180);
		expect(first.x as number).toBeLessThan(190);
	});
	test("follows the planned route through a hover menu before clicking", async () => {
		const f = fixture();
		f.page.executeJavaScript = async code => code.includes("const verifyTarget") ? true : ({ x: 360, y: 180, width: 800, height: 600, path: [{ x: 24, y: 180 }, { x: 360, y: 180 }] });
		await f.run({ action: "click", selector: "button" });
		const moves = f.commands.filter(c => c.params?.type === "mouseMoved");
		expect(moves).toHaveLength(24);
		expect(moves[11].params).toMatchObject({ x: 24, y: 180 });
		expect(moves[23].params).toMatchObject({ x: 360, y: 180 });
	});
	test("does not click the background if the target disappears during movement", async () => {
		const f = fixture();
		f.page.executeJavaScript = async code => code.includes("const verifyTarget") ? false : ({ x: 180, y: 90, width: 800, height: 600 });
		await expect(f.run({ action: "click", selector: "button" })).rejects.toThrow("during pointer movement");
		expect(f.commands.some(c => c.params?.type === "mousePressed")).toBe(false);
	});
	test("moves through intermediate points and clicks at the visible pointer", async () => {
		const f = fixture();
		await f.run({ action: "click", selector: "button" });
		const moves = f.commands.filter(c => c.params?.type === "mouseMoved");
		expect(moves.length).toBe(12);
		expect(moves[0].params!.x as number).toBeLessThan(180);
		expect(moves.at(-1)!.params).toMatchObject({ x: 180, y: 90 });
		expect(f.commands.at(-1)!.params).toMatchObject({ type: "mouseReleased", x: 180, y: 90, buttons: 0 });
		expect(f.pointers.some(p => p.phase === "down" && p.x === 180)).toBe(true);
		expect(f.detaches()).toBe(1);
		expect(f.pointers.at(-1)).toMatchObject({ x: 180, y: 90, phase: "idle" });
		expect(f.pointers.some(pointer => pointer.phase === "hide")).toBe(false);
	});
	test("inserts Unicode through Chromium and does not expose text in cursor updates", async () => {
		const f = fixture();
		await f.run({ action: "type", selector: "input", text: "你好 🐱 secret" });
		expect(f.commands.find(c => c.method === "Input.insertText")!.params).toEqual({ text: "你好 🐱 secret" });
		expect(f.commands.some(c => c.method === "Input.dispatchKeyEvent" && c.params?.key === "a" && c.params.modifiers === 2)).toBe(true);
		expect(JSON.stringify(f.pointers)).not.toContain("secret");
	});
	test("holds the mouse during drag and releases at the endpoint", async () => {
		const f = fixture();
		await f.run({ action: "drag", x: 180, y: 90, toX: 360, toY: 180 });
		const held = f.commands.filter(c => c.params?.type === "mouseMoved" && c.params.buttons === 1);
		expect(held.length).toBe(12);
		expect(f.commands.at(-1)!.params).toMatchObject({ type: "mouseReleased", x: 360, y: 180, buttons: 0 });
	});
	test("cancellation after mouse down releases the button and stops input", async () => {
		const f = fixture();
		await expect(performBrowserInput(f.page, { action: "click", selector: "button" }, {
			signal: f.controller.signal,
			onPointer: update => { if (update.phase === "down") f.controller.abort(); },
		})).rejects.toThrow("cancelled");
		expect(f.commands.at(-1)!.params).toMatchObject({ type: "mouseReleased", buttons: 0 });
		expect(f.detaches()).toBe(1);
	});
	test("a wedged command can be cancelled and releases the per-tab lock", async () => {
		const f = fixture();
		const original = f.page.debugger.sendCommand;
		f.page.debugger.sendCommand = async () => { f.controller.abort(); return new Promise(() => {}); };
		await expect(f.run({ action: "hover", selector: "button" })).rejects.toThrow("cancelled");
		f.page.debugger.sendCommand = original;
		await performBrowserInput(f.page, { action: "keypress", key: "Escape" }, { signal: new AbortController().signal, onPointer: () => {} });
		expect(f.commands.at(-1)!.params).toMatchObject({ type: "keyUp", key: "Escape" });
	});
	test("rejects invalid drag endpoints before pressing the mouse", async () => {
		const f = fixture();
		await expect(f.run({ action: "drag", selector: "button", toX: 900, toY: 100 })).rejects.toThrow("viewport");
		expect(f.commands.some(c => c.params?.type === "mousePressed")).toBe(false);
	});
});
