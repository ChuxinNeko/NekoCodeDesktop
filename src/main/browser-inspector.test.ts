import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { BrowserInspector } from "./browser-inspector";
import { elementSelectionText } from "../shared/browser";

function fixture() {
	const events: Array<{ channel: string; value: any }> = [];
	const commands: Array<{ method: string; params: any }> = [];
	const owner = { send: (channel: string, value: unknown) => events.push({ channel, value }) } as unknown as WebContents;
	const win = { webContents: owner, isDestroyed: () => false } as BrowserWindow;
	const guest = new EventEmitter() as EventEmitter & { id: number; isDestroyed: () => boolean; debugger: any };
	let attached = false;
	const debuggerApi = Object.assign(new EventEmitter(), {
		isAttached: () => attached,
		attach: () => { attached = true; },
		detach: () => { attached = false; debuggerApi.emit("detach"); },
		sendCommand: async (method: string, params: any) => {
			commands.push({ method, params });
			if (method === "DOM.resolveNode") return { object: { objectId: "picked-element" } };
			if (method === "Runtime.callFunctionOn") return { result: { value: {
				tagName: "button", name: "Save changes", selector: "#save", url: "http://localhost:5173/settings",
			} } };
			return {};
		},
	});
	Object.assign(guest, { id: 12, isDestroyed: () => false, debugger: debuggerApi });
	const inspector = new BrowserInspector(win);
	inspector.register(guest as unknown as WebContents);
	return { inspector, guest, owner, commands, events, debuggerApi };
}

describe("browser element inspector", () => {
	test("accepts only the owning renderer and its registered guests", async () => {
		const f = fixture();
		await expect(f.inspector.setInspect({} as WebContents, 12, true)).rejects.toThrow("owner");
		await expect(f.inspector.setInspect(f.owner, 13, true)).rejects.toThrow("available");
		expect(f.commands).toEqual([]);
	});
	test("picks through the Chrome overlay, sends bounded element context, then detaches", async () => {
		const f = fixture();
		await f.inspector.setInspect(f.owner, 12, true);
		expect(f.commands.find((entry) => entry.method === "Overlay.setInspectMode")?.params.mode).toBe("searchForNode");
		f.debuggerApi.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 });
		await new Promise((done) => setTimeout(done, 0));
		const selection = f.events.find((event) => event.channel === "browser:elementSelected")!.value;
		expect(selection).toEqual({ guestId: 12, tagName: "button", name: "Save changes", selector: "#save", url: "http://localhost:5173/settings" });
		expect(elementSelectionText(selection)).toContain("[button · Save changes]\n#save\nhttp://localhost:5173/settings");
		expect(f.debuggerApi.isAttached()).toBe(false);
		expect(f.events.at(-1)?.channel).toBe("browser:inspectStopped");
	});
	test("Escape and navigation cancel without adding a fabricated selection", async () => {
		const f = fixture();
		await f.inspector.setInspect(f.owner, 12, true);
		f.guest.emit("before-input-event", {}, { key: "Escape" });
		await new Promise((done) => setTimeout(done, 0));
		expect(f.debuggerApi.isAttached()).toBe(false);
		await f.inspector.setInspect(f.owner, 12, true);
		f.guest.emit("did-start-navigation", {}, "http://localhost:5173/other", false, true);
		await new Promise((done) => setTimeout(done, 0));
		expect(f.debuggerApi.isAttached()).toBe(false);
		expect(f.events.some((event) => event.channel === "browser:elementSelected")).toBe(false);
	});
});

describe("browser automation binding", () => {
	test("a bound request resolves to the registered guest and stays active", async () => {
		const f = fixture();
		let opened = false;
		const pending = f.inspector.requestAutomation("req-1", () => { opened = true; });
		expect(opened).toBe(true);
		f.inspector.bindAutomation(f.owner, "req-1", 12);
		expect(await pending).toBe(f.guest as unknown as WebContents);
		expect(f.inspector.automationGuest()).toBe(f.guest as unknown as WebContents);
	});

	test("rejects a forged sender, unknown ids, and guests that were never registered", async () => {
		const f = fixture();
		expect(() => f.inspector.bindAutomation({} as WebContents, "req-1", 12)).toThrow("owner");
		expect(() => f.inspector.bindAutomation(f.owner, "missing", 12)).toThrow("Unknown");
		const pending = f.inspector.requestAutomation("req-2", () => {});
		expect(() => f.inspector.bindAutomation(f.owner, "req-2", 99)).toThrow("available");
		await expect(pending).rejects.toThrow("available");
	});

	test("duplicate request ids reject", async () => {
		const f = fixture();
		const pending = f.inspector.requestAutomation("dup", () => {});
		await expect(f.inspector.requestAutomation("dup", () => {})).rejects.toThrow("Duplicate");
		await f.inspector.dispose();
		await expect(pending).rejects.toThrow();
	});

	test("the tool's abort signal rejects the pending request", async () => {
		const f = fixture();
		const abort = new AbortController();
		const pending = f.inspector.requestAutomation("abort-1", () => {}, abort.signal);
		abort.abort();
		await expect(pending).rejects.toThrow("aborted");
	});

	test("an already-aborted request rejects without installing or opening", async () => {
		const f = fixture();
		const abort = new AbortController();
		abort.abort();
		let opened = false;
		await expect(
			f.inspector.requestAutomation(
				"pre-aborted",
				() => { opened = true; },
				abort.signal,
			),
		).rejects.toThrow("aborted");
		expect(opened).toBe(false);
	});

	test("guest destruction clears the active automation guest", async () => {
		const f = fixture();
		const pending = f.inspector.requestAutomation("req-3", () => {});
		f.inspector.bindAutomation(f.owner, "req-3", 12);
		await pending;
		f.guest.emit("destroyed");
		expect(() => f.inspector.automationGuest()).toThrow();
	});

	test("dispose rejects every pending automation request", async () => {
		const f = fixture();
		const pending = f.inspector.requestAutomation("req-4", () => {});
		await f.inspector.dispose();
		await expect(pending).rejects.toThrow("shutting down");
		expect(() => f.inspector.automationGuest()).toThrow();
	});
});
