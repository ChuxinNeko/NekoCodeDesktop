import type { BrowserWindow, WebContents } from "electron";
import type { BrowserElementSelection } from "../shared/browser";

/** Runs against the user-picked DOM node. Never includes input values or HTML. */
export function describeSelectedElement(this: Element) {
	const element = this.nodeType === 1 ? this : this.parentElement;
	if (!element) return null;
	const clean = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
	const tagName = element.localName;
	const name = clean(element.getAttribute("aria-label")) || clean(element.getAttribute("alt")) ||
		clean(element.getAttribute("title")) ||
		(!element.matches("input,textarea,select,[contenteditable]") ? clean((element as HTMLElement).innerText) : "") ||
		element.id || tagName;
	const segments: string[] = [];
	let current: Element | null = element;
	for (let depth = 0; current && depth < 6; depth++) {
		if (current.id) { segments.unshift("#" + CSS.escape(current.id)); break; }
		let segment = current.localName;
		const parent: Element | null = current.parentElement;
		if (parent) {
			const siblings = [...parent.children].filter((node) => node.localName === current!.localName);
			if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
		}
		segments.unshift(segment);
		if (!parent && current.getRootNode() instanceof ShadowRoot) {
			segments.unshift("[shadow-root]");
			current = (current.getRootNode() as ShadowRoot).host;
		} else current = parent;
	}
	return { tagName, name, selector: segments.join(" > "), url: element.ownerDocument.URL };
}

/** Chrome's inspector intercepts the click, so selecting a link cannot follow it. */
export class BrowserInspector {
	private guests = new Map<number, WebContents>();
	private active?: WebContents;
	private generation = 0;
	constructor(private win: BrowserWindow) {}
	register(guest: WebContents): void {
		this.guests.set(guest.id, guest);
		guest.once("destroyed", () => {
			this.guests.delete(guest.id);
			if (this.active === guest) void this.stop();
		});
		guest.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
			if (mainFrame && !inPlace && this.active === guest) void this.stop();
		});
		guest.on("before-input-event", (_event, input) => {
			if (input.key === "Escape" && this.active === guest) void this.stop();
		});
		guest.debugger.on("detach", () => {
			if (this.active === guest) {
				this.active = undefined;
				this.generation++;
				this.notifyStopped(guest.id);
			}
		});
		guest.debugger.on("message", (_event, method, params) => {
			if (method === "Overlay.inspectNodeRequested" && this.active === guest)
				void this.select(guest, params.backendNodeId);
		});
	}

	async setInspect(sender: WebContents, guestId: number, enabled: boolean): Promise<void> {
		if (sender !== this.win.webContents) throw new Error("Invalid browser owner");
		const guest = this.guests.get(guestId);
		if (!guest || guest.isDestroyed()) throw new Error("Browser tab is no longer available");
		await this.stop();
		if (!enabled) return;
		if (guest.debugger.isAttached()) throw new Error("Close this page's developer tools before selecting an element");
		guest.debugger.attach("1.3");
		this.active = guest;
		try {
			await guest.debugger.sendCommand("DOM.enable");
			await guest.debugger.sendCommand("Overlay.enable");
			await guest.debugger.sendCommand("Overlay.setInspectMode", {
				mode: "searchForNode", highlightConfig: {
					showInfo: true, contentColor: { r: 74, g: 144, b: 226, a: 0.22 },
					borderColor: { r: 74, g: 144, b: 226, a: 1 },
				},
			});
		} catch (error) { await this.stop(); throw error; }
	}

	private async select(guest: WebContents, backendNodeId: number): Promise<void> {
		const generation = this.generation;
		try {
			const { object } = await guest.debugger.sendCommand("DOM.resolveNode", { backendNodeId, objectGroup: "nekocode-inspect" });
			const { result } = await guest.debugger.sendCommand("Runtime.callFunctionOn", {
				objectId: object.objectId, functionDeclaration: describeSelectedElement.toString(), returnByValue: true,
			});
			if (generation !== this.generation || this.active !== guest) return;
			const value = result.value;
			if (!value || ![value.name, value.tagName, value.selector, value.url].every((v) => typeof v === "string")) return;
			const selection: BrowserElementSelection = {
				guestId: guest.id, name: value.name.slice(0, 160), tagName: value.tagName.slice(0, 80),
				selector: value.selector.slice(0, 2000), url: value.url.slice(0, 4000),
			};
			if (!this.win.isDestroyed()) this.win.webContents.send("browser:elementSelected", selection);
		} catch { /* The selected node may have been removed by a page update. */ }
		finally { if (generation === this.generation) await this.stop(); }
	}

	private notifyStopped(guestId: number): void {
		if (!this.win.isDestroyed()) this.win.webContents.send("browser:inspectStopped", { guestId });
	}
	async stop(): Promise<void> {
		const guest = this.active;
		this.active = undefined;
		this.generation++;
		if (!guest) return;
		try {
			if (!guest.isDestroyed() && guest.debugger.isAttached()) {
				await guest.debugger.sendCommand("Overlay.setInspectMode", { mode: "none" });
				guest.debugger.detach();
			}
		} catch { /* Navigation or window shutdown. */ }
		this.notifyStopped(guest.id);
	}
}
