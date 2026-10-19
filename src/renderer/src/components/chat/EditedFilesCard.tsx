// FILE: EditedFilesCard.tsx
// Purpose: The turn's file-change summary. While a turn is running it is a capsule
//          floating above the composer; once the turn ends it is a scrolling card
//          in the transcript, with undo and review.
// Layer: Chat component

import { useState } from "react";
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
import { EditedFilesCapsule } from "./EditedFilesCapsule";
import { EditedFileRow } from "./EditedFileRow";

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
 * line totals). Hovering opens a compact file list; selecting a file opens
 * its diff in the right dock. The full card is rendered in the
 * transcript after the turn ends, so it scrolls with the conversation.
 */
export function EditedFilesCard({
	checkpoint,
	live = false,
	disabled,
	onRestore,
	onReview,
	onOpenFile,
	onOpenDiff,
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
	/** Open a selected change in the right dock's diff pane. */
	onOpenDiff?: (path: string) => void;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const files = checkpoint.files;
	if (live) return <EditedFilesCapsule checkpoint={checkpoint} onOpenDiff={onOpenDiff ?? onOpenFile} onReview={onReview} />;

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
				{shown.map(file => <EditedFileRow key={file.path} checkpointId={checkpoint.id} file={file}
					onOpenDiff={onOpenDiff ?? onOpenFile} />)}
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
