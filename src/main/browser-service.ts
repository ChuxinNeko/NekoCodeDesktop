import { session, type BrowserWindow, type WebContents, type WebPreferences } from "electron";
import { BROWSER_PARTITION, type BrowserPopupRequest } from "../shared/browser";

/**
 * Main-process guard rails for the in-app browser panel.
 *
 * The panel itself is a renderer-owned `<webview>`; this module owns everything the
 * renderer must not be able to weaken: guest web preferences, the permission policy
 * for the browser session, and routing popups into panel tabs instead of native
 * windows.
 */

/** Applied to every guest so a renderer cannot attach a privileged webview. */
function hardenGuestPreferences(webPreferences: WebPreferences): void {
	webPreferences.partition = BROWSER_PARTITION;
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
function installBrowserPermissionPolicy(): void {
	session.fromPartition(BROWSER_PARTITION).setPermissionRequestHandler((_contents, _permission, callback) => {
		callback(false);
	});
	session.fromPartition(BROWSER_PARTITION).setPermissionCheckHandler(() => false);
}

export function installBrowserGuards(win: BrowserWindow): void {
	installBrowserPermissionPolicy();

	win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
		if (params.partition !== BROWSER_PARTITION) {
			event.preventDefault();
			return;
		}
		hardenGuestPreferences(webPreferences);
	});

	win.webContents.on("did-attach-webview", (_event, guest) => {
		routeGuestPopups(win, guest);
	});
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
