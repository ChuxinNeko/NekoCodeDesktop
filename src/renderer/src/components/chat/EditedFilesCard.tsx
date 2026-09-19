// FILE: EditedFilesCard.tsx
// Purpose: The turn-closing "edited N files" summary — the Codex-style rollup of
//          every file a turn's edits touched, with undo (checkpoint restore) and
//          review as the card's two actions.
// Layer: Chat component

import { useState } from "react";
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

/** Rows listed before the rest fold behind a "show more" line. */
const COLLAPSED_FILE_COUNT = 5;

/**
 * What a turn changed, once — at the tail of it.
 *
 * The per-call diff cards inside the work group show each edit as it happens;
 * this answers the question that is left once the turn is done: which files is
 * the answer standing on, and how much did each move? The data is the turn's
 * own checkpoint — the journal already sums each tool call's lines per path, so
 * the card is a render of what the transcript recorded, not a second diff.
 *
 * It appears only once the turn it belongs to is over, so the count it opens
 * with is the count it keeps. An earlier turn's card can still be on screen
 * while a later one runs, and restoring is disabled for as long as it is — a
 * rewind would race the run.
 */
export function EditedFilesCard({
	checkpoint,
	disabled,
	onRestore,
	onReview,
	onOpenFile,
}: {
	/** The checkpoint the turn started from; its `files` are the turn's edits. */
	checkpoint: CheckpointSummary;
	/** A run is in flight, so a rewind would race it. */
	disabled?: boolean;
	onRestore?: (checkpoint: CheckpointSummary) => void;
	onReview?: () => void;
	/** Show a file in the dock's Files pane when its row is clicked. */
	onOpenFile?: (path: string) => void;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const files = checkpoint.files;
	const shown = expanded ? files : files.slice(0, COLLAPSED_FILE_COUNT);
	const hidden = files.length - shown.length;

	return (
		<div className="overflow-hidden rounded-xl border border-border/60">
			<div className="flex items-center gap-1.5 px-2.5 py-1.5">
				<PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] font-medium">
					{t("fileEdit.summary", { count: files.length })}
				</span>
				<DiffStat
					className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)]"
					insertions={checkpoint.additions}
					deletions={checkpoint.deletions}
				/>
				<span className="flex-1" />
				{onRestore ? (
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
			<div className="border-t border-border/60 py-0.5">
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
		</div>
	);
}
