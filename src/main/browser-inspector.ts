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
	private automation?: WebContents;
	private automationPending = new Map<
		string,
		{
			resolve: (guest: WebContents) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private automationWatchers = new Set<(reason: string) => void>();
	private generation = 0;
	constructor(private win: BrowserWindow) {}
	register(guest: WebContents): void {
		this.guests.set(guest.id, guest);
		guest.once("destroyed", () => {
			this.guests.delete(guest.id);
			if (this.active === guest) void this.stop();
			if (this.automation === guest) {
				this.automation = undefined;
				this.invalidateAutomation("The page bound for automation was closed");
			}
		});
		guest.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
			if (!mainFrame || inPlace) return;
			if (this.active === guest) void this.stop();
			if (this.automation === guest) {
				this.invalidateAutomation(
					"The page navigated while the call was in flight, so it can no longer answer it. Never navigate or reload from inside an expression — use browser_navigate, then call again.",
				);
			}
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

	private invalidateAutomation(reason: string): void {
		for (const watcher of [...this.automationWatchers]) watcher(reason);
	}

	/**
	 * Called when the page bound for automation stops being able to answer: it was
	 * closed, or it navigated out from under the call in flight.
	 *
	 * Electron settles `executeJavaScript` from a callback owned by the page's
	 * execution context, so a reload started by the very expression being evaluated
	 * drops that callback and leaves a promise that can never settle. A tool that
	 * waits on it wedges the agent run — and with it the stop button — so the tools
	 * watch for the page going away instead of trusting it to reply.
	 */
	watchAutomation(onInvalidate: (reason: string) => void): () => void {
		this.automationWatchers.add(onInvalidate);
		return () => this.automationWatchers.delete(onInvalidate);
	}

	private failAutomation(requestId: string, error: Error): void {
		const pending = this.automationPending.get(requestId);
		if (!pending) return;
		this.automationPending.delete(requestId);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	requestAutomation(requestId: string, open: () => void, signal?: AbortSignal): Promise<WebContents> {
		if (signal?.aborted) return Promise.reject(new Error("Automation request aborted"));
		if (this.automationPending.has(requestId)) {
			return Promise.reject(new Error(`Duplicate automation request: ${requestId}`));
		}
		const promise = new Promise<WebContents>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.automationPending.delete(requestId);
				reject(new Error("Timed out waiting for the browser panel to bind the page"));
			}, 30_000);
			this.automationPending.set(requestId, { resolve, reject, timer });
		});
		const onAbort = () => this.failAutomation(requestId, new Error("Automation request aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		void promise.then(cleanup, cleanup);
		try {
			open();
		} catch (error) {
			this.failAutomation(requestId, error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	bindAutomation(sender: WebContents, requestId: string, guestId: number): void {
		if (sender !== this.win.webContents) throw new Error("Invalid browser owner");
		const pending = this.automationPending.get(requestId);
		if (!pending) throw new Error(`Unknown or expired automation request: ${requestId}`);
		const guest = this.guests.get(guestId);
		if (!guest || guest.isDestroyed()) {
			this.failAutomation(requestId, new Error("Browser tab is no longer available"));
			throw new Error("Browser tab is no longer available");
		}
		this.automationPending.delete(requestId);
		clearTimeout(pending.timer);
		this.automation = guest;
		pending.resolve(guest);
	}

	automationGuest(): WebContents {
		const guest = this.automation;
		if (!guest || guest.isDestroyed()) {
			throw new Error("No page is bound for automation; call browser_navigate first");
		}
		return guest;
	}

	async dispose(): Promise<void> {
		for (const requestId of [...this.automationPending.keys()]) {
			this.failAutomation(requestId, new Error("Browser automation is shutting down"));
		}
		this.automation = undefined;
		this.invalidateAutomation("Browser automation is shutting down");
		await this.stop();
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
