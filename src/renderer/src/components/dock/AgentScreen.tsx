import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../beautiful-ui/Button";

// Visual structure from Beautiful UI's AgentScreen supplied by the user.
// Live media stays in one native dialog so zooming never remounts a canvas/webview.
const openIcon = <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>;
const collapseIcon = <><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></>;
function Ico({ path, size = 15 }: { path: ReactNode; size?: number }) {
	return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{path}</svg>;
}

export function AgentScreen({ title, sourceKey, visible, expandable, aspectRatio = 2964 / 1856, actions, footer, onCollapse, children }: {
	title: string;
	sourceKey: string | null;
	visible: boolean;
	expandable: boolean;
	aspectRatio?: number;
	actions?: ReactNode;
	footer?: ReactNode;
	onCollapse?: () => void;
	children: (viewer: { expanded: boolean; collapse: () => void }) => ReactNode;
}) {
	const { t } = useTranslation();
	const [expandedSource, setExpandedSource] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const openRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const expanded = visible && expandable && sourceKey !== null && expandedSource === sourceKey;
	const collapse = () => setExpandedSource(null);

	useEffect(() => { setExpandedSource(null); }, [sourceKey, visible, expandable]);
	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || !expanded) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		dialog.close();
		dialog.showModal();
		closeRef.current?.focus({ preventScroll: true });
		return () => {
			onCollapse?.();
			dialog.close();
			if (dialog.isConnected) dialog.show();
			document.body.style.overflow = previousOverflow;
			openRef.current?.focus({ preventScroll: true });
		};
	}, [expanded]);

	return (
		<div className="beautiful-agent-screen flex min-h-0 flex-1 flex-col" data-agent-screen="">
			<div className="min-h-0 flex-1 overflow-auto p-3">
				<div className="mx-auto w-full max-w-[340px]">
					<dialog
						ref={dialogRef} open role={expanded ? "dialog" : "group"} aria-modal={expanded || undefined}
						aria-label={t("desktop.screenTitle", { name: title })} data-expanded={expanded}
						className={cn(
							"border-0 text-bui-ink outline-none",
							expanded
								? "fixed inset-0 m-auto flex max-h-full max-w-none flex-col overflow-hidden rounded-[16px] bg-bui-surface p-2 pt-0 shadow-bui-overlay backdrop:bg-black/60 dark:backdrop:bg-black/75"
								: "relative inset-auto m-0 w-full max-w-none overflow-visible bg-transparent p-0",
						)}
						style={expanded ? { width: `calc(min(960px, 90vw, (100dvh - 150px) * ${aspectRatio}) + 16px)`, animation: "bui-pop-in 240ms cubic-bezier(0.23,1,0.32,1) both" } : undefined}
						onCancel={event => { event.preventDefault(); collapse(); }}
						onKeyDownCapture={event => {
							if (expanded && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); collapse(); }
						}}
						onPointerDown={event => {
							if (!expanded || event.target !== event.currentTarget) return;
							const rect = event.currentTarget.getBoundingClientRect();
							if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) collapse();
						}}
					>
						{expanded && <div className="flex h-11 shrink-0 items-center justify-between gap-3 px-1.5">
							<span className="min-w-0 truncate text-[13px] font-semibold text-bui-ink">{title}</span>
							<div className="flex shrink-0 items-center gap-1.5">
								{actions}
								<button ref={closeRef} type="button" aria-label={t("desktop.collapse")} title={t("desktop.collapseHint")} onClick={collapse} className="primitive-icon-button text-bui-ink-3 transition-colors duration-100 hover:bg-bui-hover hover:text-bui-ink"><Ico path={collapseIcon} /></button>
							</div>
						</div>}
						<div
							className={cn("group/screen relative min-h-0 overflow-hidden bg-bui-inset", expanded ? "rounded-[8px]" : "rounded-bui-window shadow-bui-card transition-shadow duration-150", !expanded && expandable && "cursor-pointer hover:shadow-bui-raised")}
							style={{ aspectRatio, ...(!expanded ? { animation: "bui-fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" } : {}) }}
						>
							<div className="absolute inset-0 flex min-h-0 flex-col" inert={!expanded && expandable}>{children({ expanded, collapse })}</div>
							{!expanded && expandable && <>
								<button ref={openRef} type="button" aria-label={t("desktop.expand")} aria-haspopup="dialog" onClick={() => setExpandedSource(sourceKey)} className="absolute inset-0 cursor-pointer bg-[rgba(17,19,24,0)] transition-colors duration-150 group-hover/screen:bg-[rgba(17,19,24,0.18)] focus-visible:bg-[rgba(17,19,24,0.18)]" />
								<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
									<span className="translate-y-1 opacity-0 transition duration-150 group-hover/screen:translate-y-0 group-hover/screen:opacity-100 group-focus-within/screen:translate-y-0 group-focus-within/screen:opacity-100">
										<Button variant="accent" size="sm" className="pointer-events-auto" onClick={() => setExpandedSource(sourceKey)}><Ico size={14} path={openIcon} />{t("desktop.openScreen")}</Button>
									</span>
								</div>
							</>}
						</div>
					</dialog>
					<div className="mt-2.5 truncate px-0.5 text-[13px] font-medium text-bui-ink">{t("desktop.screenTitle", { name: title })}</div>
				</div>
			</div>
			{footer}
		</div>
	);
}
