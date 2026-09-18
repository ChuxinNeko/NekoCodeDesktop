import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import {
	BROWSER_PARTITION,
	type BrowserTabState,
	type BrowserPreviewRequest,
	browserUrlLabel,
	isBlankBrowserUrl,
	resolveBrowserInputUrl,
} from "../../../shared/browser";
import { api } from "../api";
import { useTranslation } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	ExternalLinkIcon,
	GlobeIcon,
	GoalIcon,
	PlusIcon,
	RefreshCwIcon,
	StopIcon,
	XIcon,
} from "../lib/icons";

// Chrome-control surface shared by the address field and tab pills, so the whole row
// reads as one control. Mirrors Synara's BrowserPanel chrome tokens.
const BROWSER_CHROME_CONTROL_CLASS_NAME = "h-8 rounded-lg border text-xs";
const BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME = "border-border bg-background/70";

let tabSequence = 0;
function makeTab(url = "", title = "New tab"): BrowserTabState {
	tabSequence += 1;
	return {
		id: `browser-tab-${String(tabSequence)}`,
		title,
		url,
		loading: false,
		canGoBack: false,
		canGoForward: false,
	};
}

function scrollTabIntoView(strip: HTMLElement, tab: HTMLElement): void {
	const stripRect = strip.getBoundingClientRect();
	const tabRect = tab.getBoundingClientRect();
	const left = tabRect.left - stripRect.left + strip.scrollLeft;
	const right = left + tabRect.width;
	if (left < strip.scrollLeft) strip.scrollLeft = left;
	else if (right > strip.scrollLeft + strip.clientWidth) {
		strip.scrollLeft = right - strip.clientWidth;
	}
}

/** The subset of a webview element this module toggles classes on. */
interface GuestElement {
	classList: { toggle(name: string, force: boolean): void };
}

/**
 * Show exactly one guest: the browser's active tab, and only while the dock is
 * showing the browser at all.
 *
 * The second half is the part that is easy to leave out and the reason this is
 * a named function. The dock hides a pane it is not showing by putting
 * `invisible` on it and relying on the pane to inherit that. `visibility` does
 * inherit — but a descendant declaring `visibility: visible` overrides an
 * ancestor's `hidden`, and `.visible` is exactly that declaration. A guest left
 * marked visible therefore went on painting over whichever tool the dock had
 * switched to, while the tab strip already said otherwise.
 *
 * Every other dock pane is plain DOM that never re-declares its own visibility,
 * which is why this was the only one that leaked through.
 */
export function syncGuestVisibility(
	guests: Iterable<readonly [string, GuestElement]>,
	activeTabId: string,
	panelVisible: boolean,
): void {
	for (const [tabId, element] of guests) {
		const shown = panelVisible && tabId === activeTabId;
		element.classList.toggle("visible", shown);
		element.classList.toggle("invisible", !shown);
	}
}

export function BrowserPanel({ onClose, preview, visible = true }: {
	onClose: () => void;
	preview?: BrowserPreviewRequest | null;
	visible?: boolean;
}) {
	const { t } = useTranslation();
	const [tabs, setTabs] = useState<BrowserTabState[]>(() => [makeTab("", t("browser.newTab"))]);
	const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]?.id ?? "");
	const [addressDraft, setAddressDraft] = useState("");
	const [addressFocused, setAddressFocused] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [inspecting, setInspecting] = useState(false);
	const inspectGuest = useRef<number | null>(null);
	const lastPreview = useRef<string | null>(null);
	const webviews = useRef(new Map<string, WebviewTag>());
	const stripRef = useRef<HTMLDivElement | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);

	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

	const updateTab = useCallback((tabId: string, patch: Partial<BrowserTabState>) => {
		setTabs((current) =>
			current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
		);
	}, []);

	const createTab = useCallback(
		(url = "") => {
			const tab = makeTab(url, t("browser.newTab"));
			setTabs((current) => [...current, tab]);
			setActiveTabId(tab.id);
			return tab;
		},
		[t],
	);

	const closeTab = useCallback(
		(tabId: string) => {
			setTabs((current) => {
				const next = current.filter((tab) => tab.id !== tabId);
				if (next.length === 0) {
					// Closing the last tab leaves one blank tab rather than an empty panel.
					const replacement = makeTab("", t("browser.newTab"));
					setActiveTabId(replacement.id);
					return [replacement];
				}
				if (tabId === activeTabId) {
					const index = current.findIndex((tab) => tab.id === tabId);
					const fallback = next[Math.max(0, index - 1)] ?? next[0];
					if (fallback) setActiveTabId(fallback.id);
				}
				return next;
			});
			webviews.current.get(tabId)?.remove();
			webviews.current.delete(tabId);
		},
		[activeTabId, t],
	);

	// Guest popups (target=_blank / window.open) open as panel tabs.
	useEffect(() => {
		return api.onBrowserPopup((request) => {
			const url = resolveBrowserInputUrl(request.url);
			if (url) createTab(url);
		});
	}, [createTab]);

	useEffect(() => {
		if (!preview || lastPreview.current === preview.id) return;
		lastPreview.current = preview.id;
		setError(null);
		const existing = tabs.find((tab) => tab.url === preview.url);
		if (existing) {
			setActiveTabId(existing.id);
			if (preview.kind === "html") webviews.current.get(existing.id)?.reload();
		} else createTab(preview.url);
	}, [preview, tabs, createTab]);

	useEffect(() => api.onBrowserInspectStopped(({ guestId }) => {
		if (inspectGuest.current !== guestId) return;
		inspectGuest.current = null;
		setInspecting(false);
	}), []);

	const stopInspecting = useCallback(() => {
		const guestId = inspectGuest.current;
		inspectGuest.current = null;
		setInspecting(false);
		if (guestId !== null) void api.browserSetInspect(guestId, false).catch(() => {});
	}, []);

	// Hidden tabs cannot keep intercepting clicks or keyboard input.
	useEffect(() => { stopInspecting(); }, [activeTabId, visible, stopInspecting]);
	useEffect(() => () => {
		const guestId = inspectGuest.current;
		if (guestId !== null) void api.browserSetInspect(guestId, false).catch(() => {});
		for (const element of webviews.current.values()) element.remove();
		webviews.current.clear();
	}, []);

	const toggleInspecting = async () => {
		if (inspecting) { stopInspecting(); return; }
		try {
			const guest = activeTab && webviews.current.get(activeTab.id);
			if (!guest) return;
			const id = guest.getWebContentsId();
			inspectGuest.current = id;
			await api.browserSetInspect(id, true);
			if (inspectGuest.current === id) setInspecting(true);
		} catch (cause) {
			inspectGuest.current = null;
			setInspecting(false);
			setError(String(cause));
		}
	};

	useLayoutEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const active = strip.querySelector<HTMLElement>('[data-browser-tab-active="true"]');
		if (active) scrollTabIntoView(strip, active);
	}, [activeTabId]);

	useEffect(() => {
		if (activeTab && !addressFocused) {
			setAddressDraft(isBlankBrowserUrl(activeTab.url) ? "" : activeTab.url);
		}
	}, [activeTab, addressFocused]);

	/**
	 * Guest elements are created imperatively rather than rendered as JSX.
	 *
	 * Electron reads `allowpopups` when the <webview> connects, and React omits that
	 * attribute on the host element — so a declarative <webview> is always created
	 * without popup support and `window.open` / `target=_blank` is dropped before the
	 * main-process handler can turn it into a tab. Creating the element by hand lets
	 * the attribute be set before it is ever connected.
	 */
	const attachWebviewListeners = useCallback(
		(tabId: string, element: WebviewTag) => {
			const sync = () => {
				updateTab(tabId, {
					url: element.getURL(),
					title: element.getTitle() || browserUrlLabel(element.getURL()),
					canGoBack: element.canGoBack(),
					canGoForward: element.canGoForward(),
				});
			};
			const onStart = () => updateTab(tabId, { loading: true });
			const onStop = () => {
				sync();
				updateTab(tabId, { loading: false });
			};
			const onTitle = (event: Electron.PageTitleUpdatedEvent) =>
				updateTab(tabId, { title: event.title || browserUrlLabel(element.getURL()) });
			const onFavicon = (event: Electron.PageFaviconUpdatedEvent) =>
				updateTab(tabId, { faviconUrl: event.favicons[0] });
			const onFail = (event: Electron.DidFailLoadEvent) => {
				if (event.errorCode === -3) return; // ERR_ABORTED: a superseded navigation
				updateTab(tabId, { loading: false });
				setError(t("browser.loadFailed", { url: event.validatedURL, reason: event.errorDescription }));
			};

			element.addEventListener("did-start-loading", onStart);
			element.addEventListener("did-stop-loading", onStop);
			element.addEventListener("did-navigate", sync);
			element.addEventListener("did-navigate-in-page", sync);
			element.addEventListener("page-title-updated", onTitle);
			element.addEventListener("page-favicon-updated", onFavicon);
			element.addEventListener("did-fail-load", onFail);
		},
		[updateTab, t],
	);

	// Keep one guest per tab, created before connection and removed with its tab.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		for (const tab of tabs) {
			if (webviews.current.has(tab.id)) continue;
			const element = document.createElement("webview") as WebviewTag;
			element.setAttribute("allowpopups", "true");
			element.setAttribute("partition", BROWSER_PARTITION);
			element.setAttribute("src", tab.url || "about:blank");
			element.className = "absolute inset-0 size-full invisible";
			attachWebviewListeners(tab.id, element);
			host.appendChild(element);
			webviews.current.set(tab.id, element);
		}
		for (const [tabId, element] of [...webviews.current]) {
			if (tabs.some((tab) => tab.id === tabId)) continue;
			element.remove();
			webviews.current.delete(tabId);
		}
	}, [tabs, attachWebviewListeners]);

	useEffect(() => {
		syncGuestVisibility(webviews.current, activeTabId, visible);
	}, [activeTabId, tabs, visible]);

	const navigate = (raw: string) => {
		const url = resolveBrowserInputUrl(raw);
		if (!url) {
			setError(t("browser.notUrl", { url: raw }));
			return;
		}
		setError(null);
		if (!activeTab) return;
		const webview = webviews.current.get(activeTab.id);
		if (!webview) return;
		updateTab(activeTab.id, { url });
		void webview.loadURL(url);
	};

	return (
		<section className="flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)]">
			<div className="flex items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-2 py-1.5">
				<div ref={stripRef} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
					{tabs.map((tab) => {
						const isActive = tab.id === activeTabId;
						return (
							<div
								key={tab.id}
								data-browser-tab-active={isActive ? "true" : undefined}
								className={cn(
									"group flex min-w-0 max-w-[14rem] items-center px-2.5 text-left transition-colors",
									BROWSER_CHROME_CONTROL_CLASS_NAME,
									isActive
										? cn(BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME, "text-foreground")
										: "border-transparent text-muted-foreground hover:border-border/60 hover:bg-background/40 hover:text-foreground",
								)}
							>
								<span className="mr-2 flex size-4 shrink-0 items-center justify-center rounded-sm">
									{tab.faviconUrl ? (
										<img alt="" className="size-3 rounded-[2px]" src={tab.faviconUrl} />
									) : (
										<GlobeIcon className="size-3 text-muted-foreground" />
									)}
								</span>
								<button
									type="button"
									className="min-w-0 flex-1 truncate text-left"
									onClick={() => setActiveTabId(tab.id)}
								>
									{tab.title || browserUrlLabel(tab.url)}
								</button>
								<Button
									aria-label={t("browser.closeTab")}
									className={cn(
										"ml-1 size-5 shrink-0 rounded-sm p-0 text-muted-foreground/70 hover:text-foreground",
										isActive ? "hover:bg-background" : "hover:bg-card",
									)}
									onClick={() => closeTab(tab.id)}
									size="icon-chip"
									variant="ghost"
								>
									<XIcon className="size-3" />
								</Button>
							</div>
						);
					})}
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label={t("browser.newTab")}
									className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
									onClick={() => createTab()}
									size="icon-sm"
									variant="ghost"
								/>
							}
						>
							<PlusIcon className="size-3.5" />
						</TooltipTrigger>
						<TooltipPopup>{t("browser.newTab")}</TooltipPopup>
					</Tooltip>
				</div>
				<IconButton
					label={t("browser.closePanel")}
					onClick={onClose}
					tooltip={t("common.close")}
				>
					<XIcon className="size-3.5" />
				</IconButton>
			</div>

			<div className="flex items-center gap-1 border-b border-[color:var(--app-surface-divider)] px-2 py-1.5">
				<IconButton
					disabled={!activeTab?.canGoBack}
					label={t("common.back")}
					onClick={() => {
						const webview = activeTab ? webviews.current.get(activeTab.id) : undefined;
						if (webview?.canGoBack()) webview.goBack();
					}}
				>
					<ArrowLeftIcon className="size-3.5" />
				</IconButton>
				<IconButton
					disabled={!activeTab?.canGoForward}
					label={t("common.forward")}
					onClick={() => {
						const webview = activeTab ? webviews.current.get(activeTab.id) : undefined;
						if (webview?.canGoForward()) webview.goForward();
					}}
				>
					<ArrowRightIcon className="size-3.5" />
				</IconButton>
				{activeTab?.loading ? (
					<IconButton
						label={t("common.stop")}
						onClick={() => {
							const webview = activeTab ? webviews.current.get(activeTab.id) : undefined;
							webview?.stop();
						}}
					>
						<StopIcon className="size-3.5" />
					</IconButton>
				) : (
					<IconButton
						label={t("common.reload")}
						onClick={() => {
							const webview = activeTab ? webviews.current.get(activeTab.id) : undefined;
							webview?.reload();
						}}
					>
						<RefreshCwIcon className="size-3.5" />
					</IconButton>
				)}
				<form
					className="min-w-0 flex-1"
					onSubmit={(event) => {
						event.preventDefault();
						navigate(addressDraft);
						(event.currentTarget.querySelector("input") as HTMLInputElement | null)?.blur();
					}}
				>
					<input
						aria-label={t("browser.address")}
						className={cn(
							BROWSER_CHROME_CONTROL_CLASS_NAME,
							BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME,
							"w-full min-w-0 px-2.5 outline-none focus-visible:ring-1 focus-visible:ring-ring",
						)}
						onBlur={() => setAddressFocused(false)}
						onChange={(event) => setAddressDraft(event.target.value)}
						onFocus={() => setAddressFocused(true)}
						placeholder={t("browser.addressPlaceholder")}
						spellCheck={false}
						value={addressDraft}
					/>
				</form>
				<IconButton
					disabled={!activeTab || activeTab.loading || isBlankBrowserUrl(activeTab.url)}
					label={t(inspecting ? "browser.stopInspect" : "browser.inspect")}
					tooltip={t(inspecting ? "browser.stopInspect" : "browser.inspect")}
					aria-pressed={inspecting}
					variant={inspecting ? "subtle" : "ghost"}
					onClick={() => void toggleInspecting()}
				>
					<GoalIcon className="size-3.5" />
				</IconButton>
				<IconButton
					disabled={!activeTab || isBlankBrowserUrl(activeTab.url)}
					label={t("browser.openExternal")}
					onClick={() => {
						if (activeTab && !isBlankBrowserUrl(activeTab.url)) {
							void api.openExternal(activeTab.url);
						}
					}}
				>
					<ExternalLinkIcon className="size-3.5" />
				</IconButton>
			</div>

			{inspecting ? <p role="status" className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{t("browser.inspectHint")}</p> : null}
			{error ? (
				<div className="flex items-center gap-2 border-b border-[color:var(--app-surface-divider)] bg-destructive/6 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					<span className="min-w-0 flex-1 truncate">{error}</span>
					<Button onClick={() => setError(null)} size="icon-chip" variant="ghost">
						<XIcon className="size-3" />
					</Button>
				</div>
			) : null}

			<div
				ref={hostRef}
				className="relative min-h-0 flex-1 bg-[var(--color-background-surface-under,var(--background))]"
			/>
		</section>
	);
}
