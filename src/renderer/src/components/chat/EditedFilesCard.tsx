// FILE: EditedFilesCard.tsx
// Purpose: The turn-closing "edited N files" summary — the Codex-style rollup of
//          every file a turn's edits touched, with undo (checkpoint restore) and
//          review as the card's two actions.
// Layer: Chat component

import { useId, useState } from "react";
import type { CheckpointSummary } from "../../../../shared/checkpoints";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	PencilIcon,
	Undo2Icon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Button } from "../ui/button";
import { DiffStat } from "../ui/diff-stat";
import { DisclosureRegion } from "../ui/disclosure-region";

/** Rows listed before the rest fold behind a "show more" line. */
const COLLAPSED_FILE_COUNT = 5;

/**
 * Current turn changes above the composer, or a completed turn's saved summary.
 *
 * The per-call diff cards inside the work group show each edit as it happens;
 * this answers the question that is left once the turn is done: which files is
 * the answer standing on, and how much did each move? The data is the turn's
 * own checkpoint — the journal already sums each tool call's lines per path, so
 * the card is a render of what the transcript recorded, not a second diff.
 *
 * Live lists have bounded height and hide undo until the run settles. Completed
 * summaries remain in the transcript; undo stays disabled while another run
 * is in flight.
 */
export function EditedFilesCard({
	checkpoint,
	live = false,
	disabled,
	onRestore,
	onReview,
	onOpenFile,
}: {
	/** The checkpoint the turn started from; its `files` are the turn's edits. */
	checkpoint: CheckpointSummary;
	/** Active editing presentation; the latest summary can also remain after settling. */
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
	const [listOpen, setListOpen] = useState(true);
	const listId = useId();
	const files = checkpoint.files;
	const shown = expanded ? files : files.slice(0, COLLAPSED_FILE_COUNT);
	const hidden = files.length - shown.length;

	return (
		<section aria-label={t("fileEdit.changes")} data-slot="edited-files" data-live={live || undefined}
			className={cn("overflow-hidden rounded-xl border border-border/60 bg-background", live && "mb-2 shadow-sm")}>
			<div className="flex items-center gap-1.5 px-2.5 py-1.5">
				<button type="button" onClick={() => setListOpen((value) => !value)} aria-expanded={listOpen} aria-controls={listId}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
					{!live ? <PencilIcon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
					<span className="min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] font-medium" aria-live="polite">
						{t(live ? "fileEdit.liveSummary" : "fileEdit.summary", { count: files.length })}
					</span>
					<DiffStat className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)]" insertions={checkpoint.additions} deletions={checkpoint.deletions} />
					{listOpen ? <ChevronUpIcon className="size-3 shrink-0 text-muted-foreground" /> : <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />}
				</button>
				{onRestore && !live ? (
					<Button
						disabled={disabled}
						onClick={() => onRestore(checkpoint)}
						size="xs"
						variant="chrome-outline"
					>
						<Undo2Icon className="size-3.5" />
						{t("fileEdit.undo")}
					</Button>
				) : null}
				{onReview ? (
					<Button onClick={onReview} size="xs" variant="chrome-outline">
						{t("nav.review")}
					</Button>
				) : null}
			</div>
			<DisclosureRegion id={listId} open={listOpen}>
			<div className={cn("border-t border-border/60 py-0.5", live && "max-h-36 overflow-y-auto overscroll-contain")}>
				{shown.map((file) => {
					const basename = file.path.split("/").filter(Boolean).pop() ?? file.path;
					const stat =
						file.additions > 0 || file.deletions > 0 ? (
							<DiffStat
								className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)]"
								insertions={file.additions}
								deletions={file.deletions}
							/>
						) : null;
					const rowClass = cn(
						"flex w-full items-center gap-1.5 px-2.5 py-1 text-left",
						"text-[length:var(--app-font-size-ui-sm,11px)]",
						live && "workflow-file-enter",
					);
					const rowBody = (
						<>
							<FileTypeIcon name={basename} className="size-3.5 shrink-0" />
							<span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
								{file.path}
							</span>
							{stat}
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
							"flex w-full items-center gap-1 px-2.5 py-1 text-left transition-colors",
							"text-[length:var(--app-font-size-ui-xs,10px)] hover:text-foreground",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{expanded ? (
							<>
								<ChevronUpIcon className="size-3 shrink-0" />
								{t("fileEdit.showLess")}
							</>
						) : (
							<>
								<ChevronDownIcon className="size-3 shrink-0" />
								{t("fileEdit.showMore", { count: hidden })}
							</>
						)}
					</button>
				) : null}
			</div>
			</DisclosureRegion>
		</section>
	);
}
