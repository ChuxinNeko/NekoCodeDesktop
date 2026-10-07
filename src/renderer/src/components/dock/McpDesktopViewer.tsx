import { useEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import type { McpDesktopViewer as Viewer } from "../../../../shared/mcp";
import { isDesktopViewerUrl } from "../../../../shared/mcp-desktop";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";

/** A renderer-only guest. Its one-use URL never enters app state or agent tools. */
export function McpDesktopViewer({ serverId, viewer, visible, revision, onRetry }: {
	serverId: string;
	viewer: Viewer;
	visible: boolean;
	revision: number;
	onRetry: () => void;
}) {
	const { t } = useTranslation();
	const host = useRef<HTMLDivElement>(null);
	const [activated, setActivated] = useState(visible);
	const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
	useEffect(() => { if (visible) setActivated(true); }, [visible]);

	useEffect(() => {
		if (!activated || api.runtime !== "electron") return;
		let disposed = false;
		let guest: WebviewTag | null = null;
		setPhase("loading");
		void api.mcpOpenDesktop(serverId).then(connection => {
			if (disposed || !host.current) return;
			if (connection.serverId !== serverId || connection.partition !== viewer.partition || !isDesktopViewerUrl(viewer, connection.viewerUrl, true)) {
				setPhase("error");
				return;
			}
			guest = document.createElement("webview") as WebviewTag;
			guest.className = "absolute inset-0 size-full";
			guest.setAttribute("partition", connection.partition);
			guest.addEventListener("did-start-loading", () => { if (!disposed) setPhase("loading"); });
			guest.addEventListener("did-stop-loading", () => { if (!disposed) setPhase(current => current === "error" ? current : "ready"); });
			guest.addEventListener("did-fail-load", event => {
				// ERR_ABORTED is also emitted when a navigation is superseded.
				if (!disposed && event.errorCode !== -3 && event.isMainFrame) setPhase("error");
			});
			guest.addEventListener("render-process-gone", () => { if (!disposed) setPhase("error"); });
			guest.setAttribute("src", connection.viewerUrl);
			host.current.appendChild(guest);
		}).catch(() => { if (!disposed) setPhase("error"); });
		return () => {
			disposed = true;
			guest?.remove();
			guest = null;
		};
	}, [activated, serverId, viewer.url, viewer.partition, revision]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<div ref={host} className="relative min-h-0 flex-1" />
			{api.runtime !== "electron" || phase !== "ready" ? (
				<div className="absolute inset-0 flex items-center justify-center bg-background px-4">
					<div className="flex max-w-80 flex-col items-center gap-2 text-center text-xs leading-relaxed">
						<p className={phase === "error" ? "text-destructive" : "text-muted-foreground"}>
							{t(api.runtime !== "electron" ? "desktop.mcpDesktopOnly" : phase === "error" ? "desktop.mcpFailed" : "desktop.connecting")}
						</p>
						{api.runtime === "electron" && phase === "error" ? <Button onClick={onRetry} size="xs" variant="subtle">{t("desktop.mcpReload")}</Button> : null}
					</div>
				</div>
			) : null}
		</div>
	);
}
