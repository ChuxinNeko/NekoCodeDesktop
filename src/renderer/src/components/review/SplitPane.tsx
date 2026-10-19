// FILE: SplitPane.tsx
// Purpose: A resizable list-and-detail layout that stacks when the panel is narrow,
//          as it is when docked beside the chat.
// Layer: Review workbench

import { useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { usePersistentState, useElementWidth } from "./hooks";

/** Below this the sidebar and detail cannot both be useful side by side. */
const COMPACT_WIDTH = 640;
const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 560;
const DEFAULT_SIDEBAR = 320;

const isWidth = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function SplitPane({
	sidebar,
	main,
	storageKey = "nekocode:review:sidebar",
	defaultWidth = DEFAULT_SIDEBAR,
	compactBelow = COMPACT_WIDTH,
	compactHeight = "h-[56%]",
}: {
	sidebar: ReactNode;
	main: ReactNode;
	storageKey?: string;
	defaultWidth?: number;
	/** Container width under which the two panes stack instead of sitting side by side. */
	compactBelow?: number;
	/** Height class of the top pane while stacked. */
	compactHeight?: string;
}) {
	const { t } = useTranslation();
	const root = useRef<HTMLDivElement | null>(null);
	const width = useElementWidth(root);
	const compact = width > 0 && width < compactBelow;
	const [stored, setStored] = usePersistentState(storageKey, defaultWidth, isWidth);
	const size = Math.min(Math.max(stored, MIN_SIDEBAR), Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, width - 280)));

	const startDrag = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const startX = event.clientX;
			const startSize = size;
			const target = event.currentTarget;
			target.setPointerCapture(event.pointerId);
			const move = (next: PointerEvent) => {
				setStored(Math.round(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startSize + next.clientX - startX))));
			};
			const stop = () => {
				target.removeEventListener("pointermove", move);
				target.removeEventListener("pointerup", stop);
				target.removeEventListener("pointercancel", stop);
			};
			target.addEventListener("pointermove", move);
			target.addEventListener("pointerup", stop);
			target.addEventListener("pointercancel", stop);
		},
		[setStored, size],
	);

	return (
		<div ref={root} className={cn("flex min-h-0 min-w-0 flex-1", compact ? "flex-col" : "flex-row")}>
			<div
				className={cn(
					"flex min-h-0 min-w-0 shrink-0 flex-col overflow-y-auto",
					compact ? cn(compactHeight, "min-h-32 border-b border-[color:var(--app-surface-divider)]") : "",
				)}
				style={compact ? undefined : { width: size }}
			>
				{sidebar}
			</div>
			{compact ? null : (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label={t("review.sidebar.resize")}
					onPointerDown={startDrag}
					onDoubleClick={() => setStored(defaultWidth)}
					className="group relative z-10 -mx-px w-[3px] shrink-0 cursor-col-resize bg-[var(--app-surface-divider)] transition-colors hover:bg-[var(--color-border-focus)]"
				>
					<span className="absolute inset-y-0 -left-1 -right-1" />
				</div>
			)}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
		</div>
	);
}
