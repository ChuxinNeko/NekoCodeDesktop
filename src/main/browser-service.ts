import { session, type BrowserWindow, type WebContents, type WebPreferences } from "electron";
import { BROWSER_PARTITION, type BrowserPopupRequest } from "../shared/browser";
import type { McpDesktopViewer } from "../shared/mcp";
import { isDesktopViewerUrl } from "../shared/mcp-desktop";
import { BrowserInspector } from "./browser-inspector";

/**
 * Main-process guard rails for the in-app browser panel.
 *
 * The panel itself is a renderer-owned `<webview>`; this module owns everything the
 * renderer must not be able to weaken: guest web preferences, the permission policy
 * for the browser session, and routing popups into panel tabs instead of native
 * windows.
 */

/** Applied to every guest so a renderer cannot attach a privileged webview. */
function hardenGuestPreferences(webPreferences: WebPreferences, partition = BROWSER_PARTITION): void {
	delete webPreferences.preload;
	webPreferences.partition = partition;
	webPreferences.contextIsolation = true;
	webPreferences.sandbox = true;
	webPreferences.nodeIntegration = false;
	webPreferences.nodeIntegrationInSubFrames = false;
	webPreferences.webSecurity = true;
	webPreferences.allowRunningInsecureContent = false;
	webPreferences.webviewTag = false;
}

/**
 * Deny every permission request from guest pages. Browsing is for inspecting local
 * previews and docs; camera, microphone, geolocation, notifications, and clipboard
 * reads are not part of that job, and granting them silently would be worse than
 * refusing. Pages that need one of these must be opened in the system browser.
 */
function installBrowserPermissionPolicy(partition = BROWSER_PARTITION): void {
	session.fromPartition(partition).setPermissionRequestHandler((_contents, _permission, callback) => {
		callback(false);
	});
	session.fromPartition(partition).setPermissionCheckHandler(() => false);
}

const desktopGuests = new WeakMap<BrowserWindow, Map<number, { guest: WebContents; viewer: McpDesktopViewer }>>();

/** Disable removed/signed-out sources even if the renderer has not updated yet. */
export function revokeUnavailableDesktopGuests(win: BrowserWindow, viewers: readonly McpDesktopViewer[]): void {
	for (const { guest, viewer } of desktopGuests.get(win)?.values() ?? []) {
		if (!guest.isDestroyed() && !viewers.some(next => next.partition === viewer.partition && next.url === viewer.url)) {
			guest.close({ waitForBeforeUnload: false });
		}
	}
}

export function installBrowserGuards(win: BrowserWindow, viewers: () => readonly McpDesktopViewer[] = () => []): BrowserInspector {
	installBrowserPermissionPolicy();
	const inspector = new BrowserInspector(win);
	const guests = new Map<number, { guest: WebContents; viewer: McpDesktopViewer }>();
	desktopGuests.set(win, guests);
	win.once("closed", () => { desktopGuests.delete(win); void inspector.dispose(); });

	win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
		if (params.partition === BROWSER_PARTITION) {
			hardenGuestPreferences(webPreferences);
			return;
		}
		const viewer = viewers().find(entry => entry.partition === params.partition && isDesktopViewerUrl(entry, params.src, true));
		if (!viewer) { event.preventDefault(); return; }
		installBrowserPermissionPolicy(viewer.partition);
		hardenGuestPreferences(webPreferences, viewer.partition);
	});

	win.webContents.on("did-attach-webview", (_event, guest) => {
		if (guest.session === session.fromPartition(BROWSER_PARTITION)) {
			routeGuestPopups(win, guest);
			inspector.register(guest);
			return;
		}
		const viewer = viewers().find(entry => guest.session === session.fromPartition(entry.partition));
		if (!viewer) { guest.close({ waitForBeforeUnload: false }); return; }
		guests.set(guest.id, { guest, viewer });
		guest.once("destroyed", () => guests.delete(guest.id));
		guest.setWindowOpenHandler(() => ({ action: "deny" }));
		guest.on("will-navigate", (event, url) => {
			if (!isDesktopViewerUrl(viewer, url)) event.preventDefault();
		});
		guest.on("will-redirect", (event, url) => {
			if (!isDesktopViewerUrl(viewer, url)) event.preventDefault();
		});
		guest.on("will-frame-navigate", event => {
			if (!isDesktopViewerUrl(viewer, event.url)) event.preventDefault();
		});
	});
	return inspector;
}

/**
 * `target=_blank` and `window.open` become panel tabs. The native window is always
 * denied: an unmanaged popup would render outside the panel's toolbar and escape the
 * permission policy above.
 */
function routeGuestPopups(win: BrowserWindow, guest: WebContents): void {
	guest.setWindowOpenHandler(({ url }) => {
		if (!win.isDestroyed()) {
			const request: BrowserPopupRequest = { url };
			win.webContents.send("browser:popup", request);
		}
		return { action: "deny" };
	});
}
