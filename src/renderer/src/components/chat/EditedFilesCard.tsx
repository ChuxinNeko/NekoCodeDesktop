// FILE: EditedFilesCard.tsx
// Purpose: The turn's file-change summary. While a turn is running it is a capsule
//          floating above the composer; once the turn ends it is a scrolling card
//          in the transcript, with undo and review.
// Layer: Chat component

import { useEffect, useId, useRef, useState } from "react";
import type { CheckpointSummary } from "../../../../shared/checkpoints";
import { useTranslation } from "../../i18n";
import {
	AddPlusIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	Undo2Icon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Button } from "../ui/button";
import { COMPOSER_FLOATING_CONTROL_CLASS_NAME } from "./composerPickerStyles";
import { LiveChangesDiff } from "./LiveChangesDiff";
import { DiffStat } from "../ui/diff-stat";

/** Rows listed before the rest fold behind a "show more" line. */
const COLLAPSED_FILE_COUNT = 3;

/**
 * Current turn changes above the composer, or a completed turn's saved summary.
 *
 * The per-call diff cards inside the work group show each edit as it happens.
 * This answers the question left once the turn is done: which files the answer
 * stands on, and how much each moved. The data is the turn's own checkpoint.
 *
 * While the run is in flight the composer shows a capsule (file count and
 * line totals). Hovering it opens the diff in a preview above the capsule;
 * the capsule itself stays the same size. The full card is rendered in the
 * transcript after the turn ends, so it scrolls with the conversation.
 */
export function EditedFilesCard({
	checkpoint,
	cwd,
	live = false,
	disabled,
	onRestore,
	onReview,
	onOpenFile,
}: {
	/** The checkpoint the turn started from; its `files` are the turn's edits. */
	checkpoint: CheckpointSummary;
	cwd?: string | null;
	/** Compact capsule above the composer while this turn is still running. */
	live?: boolean;
	/** A run is in flight, so a rewind would race it. */
	disabled?: boolean;
	onRestore?: (checkpoint: CheckpointSummary) => void;
	onReview?: () => void;
	/** Show a file in the dock's Files pane when its row is clicked. */
	onOpenFile?: (path: string) => void;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const files = checkpoint.files;
	const detailId = useId();
	const previewRef = useRef<HTMLDivElement>(null);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => () => {
		if (openTimer.current) clearTimeout(openTimer.current);
		if (closeTimer.current) clearTimeout(closeTimer.current);
	}, []);

	const cancelPreviewTimers = () => {
		if (openTimer.current) clearTimeout(openTimer.current);
		if (closeTimer.current) clearTimeout(closeTimer.current);
		openTimer.current = null;
		closeTimer.current = null;
	};
	const showPreview = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = null;
		if (previewOpen || openTimer.current) return;
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			setPreviewOpen(true);
		}, 140);
	};
	const showPreviewNow = () => {
		cancelPreviewTimers();
		setPreviewOpen(true);
	};
	const hidePreview = () => {
		if (openTimer.current) clearTimeout(openTimer.current);
		openTimer.current = null;
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			const current = previewRef.current;
			const focused = document.activeElement;
			if (current && focused instanceof Node && current.contains(focused)) return;
			setPreviewOpen(false);
		}, 120);
	};

	if (live) {
		return (
			<div className="absolute bottom-2 left-1/2 z-30 max-w-full -translate-x-1/2">
				<div
					ref={previewRef}
					className="relative w-fit max-w-full"
					onMouseEnter={showPreview}
					onMouseLeave={hidePreview}
					onFocus={showPreviewNow}
					onBlur={(event) => {
						const next = event.relatedTarget;
						if (next instanceof Node && event.currentTarget.contains(next)) return;
						hidePreview();
					}}
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						cancelPreviewTimers();
						setPreviewOpen(false);
						event.stopPropagation();
					}}
				>
					{previewOpen ? (
						<div
							id={detailId}
							role="region"
							aria-label={t("fileEdit.changes")}
							data-live-preview=""
							className="absolute bottom-full left-1/2 z-30 w-[min(42rem,100cqi)] -translate-x-1/2 pb-2"
						>
							<div className="overflow-hidden rounded-2xl border border-border/60 bg-background/80 shadow-xl backdrop-blur-xl">
								<LiveChangesDiff checkpoint={checkpoint} cwd={cwd} />
								{onReview ? (
									<button
										type="button"
										onClick={onReview}
										className="w-full border-t border-border/60 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
									>
										{t("review.title")} ↗
									</button>
								) : null}
							</div>
						</div>
					) : null}
					<button
						type="button"
						aria-expanded={previewOpen}
						aria-controls={previewOpen ? detailId : undefined}
						aria-label={t("fileEdit.changes")}
						data-slot="edited-files"
						data-live="true"
						className={cn(
							COMPOSER_FLOATING_CONTROL_CLASS_NAME,
							"flex h-8 w-fit max-w-full items-center gap-3 px-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
						)}
					>
						<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium" aria-live="polite">
							{t("fileEdit.liveSummary", { count: files.length })}
						</span>
						<DiffStat
							className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)]"
							insertions={checkpoint.additions}
							deletions={checkpoint.deletions}
						/>
						<ChevronUpIcon className="size-3 shrink-0" />
					</button>
				</div>
			</div>
		);
	}

	const shown = expanded ? files : files.slice(0, COLLAPSED_FILE_COUNT);
	const hidden = files.length - shown.length;

	return (
		<section
			aria-label={t("fileEdit.changes")}
			data-slot="edited-files"
			className="overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm"
		>
			<div className="flex items-start justify-between gap-3 px-3 py-2.5">
				<div className="flex min-w-0 items-start gap-2.5">
					<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
						<AddPlusIcon className="size-4" />
					</span>
					<div className="min-w-0">
						<div className="truncate text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
							{t("fileEdit.summary", { count: files.length })}
						</div>
						{onReview ? (
							<button
								type="button"
								onClick={onReview}
								className="mt-0.5 inline-flex items-center gap-0.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground transition-colors hover:text-foreground"
							>
								{t("fileEdit.review")}
								<ChevronRightIcon className="size-3" />
							</button>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{onRestore ? (
						<Button disabled={disabled} onClick={() => onRestore(checkpoint)} size="xs" variant="chrome-outline">
							<Undo2Icon className="size-3.5" />
							{t("fileEdit.undo")}
						</Button>
					) : null}
					{onReview ? (
						<Button onClick={onReview} size="xs" variant="chrome-outline">
							{t("fileEdit.review")}
						</Button>
					) : null}
				</div>
			</div>
			<div className="border-t border-border/60 py-1">
				{shown.map((file) => {
					const rowClass = cn(
						"flex w-full items-center gap-3 px-3 py-1.5 text-left",
						"text-[length:var(--app-font-size-ui,12px)]",
					);
					const rowBody = (
						<>
							<span className="min-w-0 flex-1 truncate" title={file.path}>
								{file.path}
							</span>
							<DiffStat
								className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)]"
								insertions={file.additions}
								deletions={file.deletions}
							/>
						</>
					);
					return onOpenFile ? (
						<button
							key={file.path}
							type="button"
							onClick={() => onOpenFile(file.path)}
							className={cn(rowClass, "transition-colors hover:bg-[var(--sidebar-accent)]")}
						>
							{rowBody}
						</button>
					) : (
						<div key={file.path} className={rowClass}>
							{rowBody}
						</div>
					);
				})}
				{hidden > 0 || expanded ? (
					<button
						type="button"
						onClick={() => setExpanded((value) => !value)}
						className={cn(
							"flex w-full items-center gap-1 px-3 py-1.5 text-left transition-colors",
							"text-[length:var(--app-font-size-ui-sm,11px)] hover:text-foreground",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{expanded ? (
							<>
								{t("fileEdit.showLess")}
								<ChevronUpIcon className="size-3 shrink-0" />
							</>
						) : (
							<>
								{t("fileEdit.showMore", { count: hidden })}
								<ChevronDownIcon className="size-3 shrink-0" />
							</>
						)}
					</button>
				) : null}
			</div>
		</section>
	);
}
