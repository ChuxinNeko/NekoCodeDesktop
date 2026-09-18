/** Browser panel contracts shared by the main process and the renderer. */

/** Session partition for in-app browsing; persisted so logins survive restarts. */
export const BROWSER_PARTITION = "persist:nekocode-browser";

export interface BrowserTabState {
	id: string;
	title: string;
	url: string;
	faviconUrl?: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
}

/**
 * A `target=_blank` / `window.open` from a guest page. The main process denies the
 * native window and asks the renderer to open the URL as a panel tab instead.
 */
export interface BrowserPopupRequest {
	url: string;
}

export interface BrowserPreviewRequest {
	id: string;
	sessionId: string;
	cwd: string;
	url: string;
	kind: "html" | "server";
}

export interface BrowserElementSelection {
	guestId: number;
	url: string;
	tagName: string;
	name: string;
	selector: string;
}

export interface ComposerInsertion { id: string; text: string; }

/** Element text is page data, never an instruction or an automatically sent prompt. */
export function elementSelectionText(element: BrowserElementSelection): string {
	return `\n[${element.tagName} · ${element.name}]\n${element.selector}\n${element.url}\n`;
}

/** URL schemes the panel is allowed to load. */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "about:"]);

export function isBlankBrowserUrl(url: string | undefined): boolean {
	return url === undefined || url === "" || url === "about:blank";
}

/**
 * Normalize typed address-bar input into a loadable URL, or return null when the
 * input is not a URL we are willing to load.
 */
export function resolveBrowserInputUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return null;
	}
	if (!ALLOWED_SCHEMES.has(parsed.protocol)) return null;
	return parsed.toString();
}

/** Host shown in a tab label when the page has no title yet. */
export function browserUrlLabel(url: string): string {
	if (isBlankBrowserUrl(url)) return "New tab";
	try {
		const parsed = new URL(url);
		return parsed.host || url;
	} catch {
		return url;
	}
}
