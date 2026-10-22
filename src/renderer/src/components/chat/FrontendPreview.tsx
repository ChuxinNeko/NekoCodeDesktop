import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import { BROWSER_PARTITION, type BrowserPreviewRequest } from "../../../../shared/browser";
import type { CheckpointSummary } from "../../../../shared/checkpoints";
import { frontendFiles } from "../../../../shared/frontend-preview";
import { interactiveMessage } from "../../../../shared/interactive-message";
import { optionalApi } from "../../api";
import { useTranslation } from "../../i18n";
import { OpenUIActionsContext } from "../../lib/openuiActions";
import { Button } from "../ui/button";

/** Keep generated app scripts in a guarded browser guest, outside the chat renderer. */
function PreviewSurface({ url, mobile, revision, onError }: { url: string; mobile: boolean; revision: number; onError: () => void }) {
	const host = useRef<HTMLDivElement>(null);
	const guest = useRef<WebviewTag | null>(null);
	const ready = useRef(false);
	const previousRevision = useRef(revision);
	const errorRef = useRef(onError);
	errorRef.current = onError;
	useLayoutEffect(() => {
		const element = document.createElement("webview") as WebviewTag;
		guest.current = element;
		ready.current = false;
		element.setAttribute("partition", BROWSER_PARTITION);
		element.setAttribute("src", url);
		element.className = "h-full w-full";
		const failed = (event: Electron.DidFailLoadEvent) => { if (event.isMainFrame && event.errorCode !== -3) errorRef.current(); };
		const loaded = () => { ready.current = true; };
		element.addEventListener("dom-ready", loaded);
		element.addEventListener("did-fail-load", failed);
		host.current?.appendChild(element);
		return () => {
			guest.current = null;
			ready.current = false;
			element.removeEventListener("dom-ready", loaded);
			element.removeEventListener("did-fail-load", failed);
			if (element.isConnected) element.remove();
		};
	}, [url]);
	useEffect(() => {
		if (previousRevision.current === revision) return;
		previousRevision.current = revision;
		if (ready.current) guest.current?.reload();
	}, [revision]);
	return <div className="overflow-auto bg-muted/30 p-2">
		<div ref={host} className="mx-auto h-[420px] overflow-hidden rounded-md bg-white" style={{ width: mobile ? 375 : "100%", maxWidth: "100%" }} />
	</div>;
}

/** A completed answer owns its preview and actions through its originating checkpoint. */
export function FrontendPreview({ checkpoint }: { checkpoint: CheckpointSummary }) {
	const { t } = useTranslation();
	const actions = useContext(OpenUIActionsContext);
	const [preview, setPreview] = useState<BrowserPreviewRequest | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const [pending, setPending] = useState(false);
	const [mobile, setMobile] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [revision, setRevision] = useState(0);
	const [visible, setVisible] = useState(false);
	const root = useRef<HTMLElement>(null);
	const generation = useRef(0);
	const bridge = optionalApi();
	const available = !!bridge?.frontendPreview;
	const files = frontendFiles(checkpoint.files.map(file => file.path));
	const fileKey = files.join("\0");
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
		const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "200px" });
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const current = ++generation.current;
		if (!visible || !available || !checkpoint.cellId || actions.disabled) return;
		setLoading(true);
		setError(false);
		void bridge!.frontendPreview!(checkpoint.sessionId, checkpoint.cellId).then(result => {
			if (generation.current === current) setPreview(result);
		}).catch(() => { if (generation.current === current) { setPreview(null); setError(true); } }).finally(() => {
			if (generation.current === current) setLoading(false);
		});
		return () => { generation.current++; };
	}, [checkpoint.sessionId, checkpoint.cellId, visible, available, revision, actions.disabled, fileKey]);
	useEffect(() => {
		if (!visible || !available) return;
		return bridge?.onBrowserPreview(request => {
			if (request.sessionId === checkpoint.sessionId && (request.kind === "html" || request.kind === "server")) setRevision(value => value + 1);
		});
	}, [checkpoint.sessionId, visible, available]);
	const disabled = actions.disabled || !actions.send || pending;
	async function send(key: "start" | "polish" | "responsive" | "test") {
		if (disabled) return;
		setPending(true);
		setError(false);
		try {
			await actions.send!({ text: interactiveMessage(t(`frontendPreview.prompt.${key}`), {
				source: "frontend-preview", sessionId: checkpoint.sessionId, promptId: checkpoint.cellId,
				files, ...(preview ? { previewUrl: preview.url } : {}),
			}) });
		} catch { setError(true); }
		finally { setPending(false); }
	}
	async function open() {
		if (!checkpoint.cellId || actions.disabled) return;
		try {
			const result = await bridge!.frontendPreview?.(checkpoint.sessionId, checkpoint.cellId, true);
			if (!result) { setPreview(null); setError(true); }
		} catch { setError(true); }
	}
	return <section ref={root} aria-label={t("frontendPreview.title")} className="mt-3 overflow-hidden rounded-xl border border-border bg-background text-sm">
		<header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
			<div><span className="font-medium">{t("frontendPreview.title")}</span><span className="ml-2 text-xs text-muted-foreground">{t("frontendPreview.live")}</span></div>
			<div className="flex flex-wrap gap-1">
				<Button size="sm" variant="ghost" aria-pressed={mobile} onClick={() => setMobile(!mobile)}>{t(mobile ? "frontendPreview.desktop" : "frontendPreview.mobile")}</Button>
				<Button size="sm" variant="ghost" disabled={loading || !available || actions.disabled} onClick={() => setRevision(value => value + 1)}>{t("frontendPreview.refresh")}</Button>
				<Button size="sm" variant="ghost" disabled={!preview || actions.disabled} onClick={() => void open()}>{t("frontendPreview.expand")}</Button>
				<Button size="sm" variant="ghost" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{t(collapsed ? "frontendPreview.show" : "frontendPreview.hide")}</Button>
			</div>
		</header>
		<div hidden={collapsed || !visible} className={collapsed || !visible ? "invisible" : undefined}>
			{preview ? <PreviewSurface url={preview.url} mobile={mobile} revision={revision} onError={() => { setPreview(null); setError(true); }} /> : loading ? <p role="status" className="p-4 text-muted-foreground">{t("frontendPreview.loading")}</p> : <div className="space-y-3 p-4 text-muted-foreground">
				<p>{t(available ? "frontendPreview.unavailable" : "frontendPreview.desktopOnly")}</p>
				{available ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => void send("start")}>{t("frontendPreview.start")}</Button> : null}
			</div>}
		</div>
		<footer className="space-y-2 border-t border-border px-3 py-3">
			<p className="text-xs text-muted-foreground">{t("frontendPreview.next")}</p>
			<div className="flex flex-wrap gap-2">{(["polish", "responsive", "test"] as const).map(key => <Button key={key} size="sm" variant="outline" disabled={disabled} onClick={() => void send(key)}>{t(`frontendPreview.${key}`)}</Button>)}</div>
			{error ? <p role="alert" className="text-xs text-destructive">{t("frontendPreview.error")}</p> : null}
		</footer>
	</section>;
}
