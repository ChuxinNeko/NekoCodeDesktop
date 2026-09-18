import { useEffect, useState } from "react";
import type {
	CheckpointDiff,
	CheckpointFileChange,
	CheckpointFileDiff,
	CheckpointSummary,
} from "../../../../shared/checkpoints";
import { relativeSessionTime } from "../../../../shared/sessions";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { useNow } from "../../hooks/useNow";
import {
	ArrowLeftIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	HistoryIcon,
	TerminalIcon,
	Undo2Icon,
} from "../../lib/icons";
import { SIDEBAR_ROW_HOVER_CLASS_NAME } from "../../lib/sidebarRowStyles";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Button } from "../ui/button";
import { DiffStat } from "../ui/diff-stat";
import { DiffView } from "../ui/diff-view";
import { Spinner } from "../ui/spinner";

/**
 * The marker a file row carries, in terms of what the *agent* did — not what
 * restoring would do.
 *
 * The two are inverses and it is easy to write the wrong one down. The list sits
 * above a diff that reads from the checkpoint forwards, so a file the agent
 * created is a green `+` here even though restoring it is a deletion; matching
 * the diff underneath matters more than matching the verb on the button.
 */
const AGENT_ACTION: Record<CheckpointFileChange["action"], { mark: string; className: string }> = {
	delete: { mark: "+", className: "text-success" },
	recreate: { mark: "−", className: "text-destructive" },
	overwrite: { mark: "~", className: "" },
};

/**
 * The files one checkpoint's turn changed, and the diff for the selected one.
 *
 * The same two-pane shape as the review panel, because it answers the same
 * question — what changed, and by how much — and reuses its `DiffStat` and
 * `DiffView` so the two read identically. What differs is where the patch comes
 * from: review asks git, and this computes it from the contents the journal kept
 * before each tool call, which is what lets it work with no repository at all.
 */
function CheckpointDetail({
	checkpoint,
	onBack,
	onRestore,
	busy,
}: {
	checkpoint: CheckpointSummary;
	onBack: () => void;
	onRestore: () => void;
	busy: boolean;
}) {
	const { t } = useTranslation();
	const [diff, setDiff] = useState<CheckpointDiff | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [patch, setPatch] = useState<CheckpointFileDiff | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setDiff(null);
		setSelected(null);
		setPatch(null);
		api
			.checkpointPreview(checkpoint.id)
			.then((preview) => {
				if (cancelled) return;
				setDiff(preview.diff);
				setSelected(preview.diff.changes[0]?.path ?? null);
			})
			.catch((cause) => {
				if (!cancelled) setError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [checkpoint.id]);

	useEffect(() => {
		if (!selected) {
			setPatch(null);
			return;
		}
		let cancelled = false;
		api
			.checkpointFileDiff(checkpoint.id, selected)
			.then((next) => {
				if (!cancelled) setPatch(next);
			})
			.catch((cause) => {
				if (!cancelled) setError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [checkpoint.id, selected]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[color:var(--app-surface-divider)] px-2">
				<Button aria-label={t("common.back")} onClick={onBack} size="icon-xs" variant="ghost">
					<ArrowLeftIcon className="size-3.5" />
				</Button>
				<span
					className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)] font-medium"
					title={checkpoint.label}
				>
					{checkpoint.label || t("checkpoint.unlabeled")}
				</span>
				{diff && diff.total > 0 ? (
					<DiffStat
						className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)]"
						insertions={diff.additions}
						deletions={diff.deletions}
					/>
				) : null}
				<Button
					disabled={busy || !(checkpoint.codeRestorable || checkpoint.conversationRestorable)}
					onClick={onRestore}
					size="xs"
					variant="chrome-outline"
				>
					<Undo2Icon className="size-3.5" />
					{t("checkpoint.confirmRestore")}
				</Button>
			</div>

			{error ? (
				<div className="border-b border-[color:var(--app-surface-divider)] px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</div>
			) : null}

			{diff && diff.shellRuns > 0 ? (
				<div className="flex items-start gap-1.5 border-b border-[color:var(--app-surface-divider)] px-2 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]">
					<CircleAlertIcon className="mt-px size-3 shrink-0" />
					<span className="min-w-0">{t("checkpoint.shellWarning", { count: diff.shellRuns })}</span>
				</div>
			) : null}

			{!diff ? (
				<div
					className={cn(
						"flex items-center gap-2 px-3 py-4 text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					<Spinner className="size-3.5" />
					{t("checkpoint.loadingPreview")}
				</div>
			) : diff.total === 0 ? (
				<p
					className={cn(
						"px-3 py-4 text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{t("checkpoint.noFileChanges")}
				</p>
			) : (
				<div className="flex min-h-0 flex-1 flex-col">
					{/* Stacked rather than side by side: the dock is narrow, and a file
					    list beside a patch would leave neither of them readable. */}
					<div className="flex max-h-44 shrink-0 flex-col overflow-y-auto border-b border-[color:var(--app-surface-divider)] p-1">
						{diff.changes.map((change) => (
							<button
								key={change.path}
								type="button"
								onClick={() => setSelected(change.path)}
								title={t(`checkpoint.action.${change.action}`)}
								className={cn(
									"flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
									"text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
									selected === change.path
										? "bg-[var(--sidebar-selected)] text-foreground"
										: "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground",
								)}
							>
								<span
									aria-hidden="true"
									className={cn("shrink-0 font-mono", AGENT_ACTION[change.action].className)}
								>
									{AGENT_ACTION[change.action].mark}
								</span>
								<span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
								{change.binary ? (
									<span className="shrink-0 text-[length:var(--app-font-size-ui-2xs,9px)]">
										{t("checkpoint.binary")}
									</span>
								) : (
									<DiffStat
										className="shrink-0 text-[length:var(--app-font-size-ui-2xs,9px)]"
										insertions={change.additions}
										deletions={change.deletions}
									/>
								)}
							</button>
						))}
						{diff.truncated ? (
							<p
								className={cn(
									"px-1.5 py-1 text-[length:var(--app-font-size-ui-xs,10px)]",
									MUTED_LABEL_TEXT_CLASS_NAME,
								)}
							>
								{t("checkpoint.andMore", { count: diff.total - diff.changes.length })}
							</p>
						) : null}
					</div>

					<div className="min-h-0 flex-1 overflow-auto">
						{patch?.binary ? (
							<p
								className={cn(
									"px-3 py-4 text-[length:var(--app-font-size-ui-sm,11px)]",
									MUTED_LABEL_TEXT_CLASS_NAME,
								)}
							>
								{t("checkpoint.binaryHint")}
							</p>
						) : (
							<DiffView patch={patch?.patch ?? ""} empty={t("checkpoint.selectFile")} />
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Every point this session can be put back to.
 *
 * There is no delete here, and nothing to clear. A checkpoint is an entry in the
 * session transcript rather than a copy of the project, so it costs the size of
 * what changed and goes away with the session it belongs to.
 */
export function CheckpointsPanel({
	checkpoints,
	busy,
	onRestore,
}: {
	checkpoints: readonly CheckpointSummary[];
	/** A run is in flight, so restoring would race it. */
	busy: boolean;
	onRestore: (checkpoint: CheckpointSummary) => void;
}) {
	const { t } = useTranslation();
	// Long interval: these rows say "3m" / "2h", so a per-second clock would be
	// a re-render a second for a label that changes once a minute at most.
	const now = useNow(30_000);
	const [openId, setOpenId] = useState<string | null>(null);

	// A checkpoint that left the active branch mid-run takes its detail view with
	// it, rather than leaving a header over an empty pane.
	const open = checkpoints.find((checkpoint) => checkpoint.id === openId) ?? null;
	useEffect(() => {
		if (openId && !open) setOpenId(null);
	}, [openId, open]);

	if (open) {
		return (
			<CheckpointDetail
				checkpoint={open}
				busy={busy}
				onBack={() => setOpenId(null)}
				onRestore={() => onRestore(open)}
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-2">
				<HistoryIcon className="size-3.5 shrink-0 opacity-70" />
				<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
					{t("checkpoint.panelTitle")}
				</span>
			</div>

			{checkpoints.length === 0 ? (
				<p
					className={cn(
						"px-3 py-6 text-center text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{t("checkpoint.empty")}
				</p>
			) : (
				<ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
					{checkpoints.map((checkpoint) => {
						const restorable = checkpoint.codeRestorable || checkpoint.conversationRestorable;
						return (
							<li key={checkpoint.id} className="contents">
								<button
									type="button"
									onClick={() => setOpenId(checkpoint.id)}
									className={cn(
										"group/checkpoint flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left",
										SIDEBAR_ROW_HOVER_CLASS_NAME,
									)}
								>
									<div className="flex min-w-0 items-center gap-1.5">
										<span
											className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)]"
											title={checkpoint.label}
										>
											{checkpoint.label || t("checkpoint.unlabeled")}
										</span>
										<span className="shrink-0 text-[length:var(--app-font-size-ui-timestamp,8px)] text-muted-foreground/50">
											{relativeSessionTime(checkpoint.createdAt, now)}
										</span>
									</div>
									<div
										className={cn(
											"flex min-w-0 items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)]",
											MUTED_LABEL_TEXT_CLASS_NAME,
										)}
									>
										<span className="shrink-0">
											{checkpoint.fileCount > 0
												? t("checkpoint.changedSince", { count: checkpoint.fileCount })
												: t("checkpoint.noChangesSince")}
										</span>
										{checkpoint.fileCount > 0 ? (
											<DiffStat
												className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)]"
												insertions={checkpoint.additions}
												deletions={checkpoint.deletions}
											/>
										) : null}
										{checkpoint.shellRuns > 0 ? (
											<span
												className="flex shrink-0 items-center gap-0.5"
												title={t("checkpoint.shellHint")}
											>
												<TerminalIcon className="size-3" />
												{checkpoint.shellRuns}
											</span>
										) : null}
										{checkpoint.conversationRestorable ? null : (
											<span className="shrink-0">{t("checkpoint.offBranch")}</span>
										)}
										<span className="flex-1" />
										{restorable ? (
											<ChevronRightIcon className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/checkpoint:opacity-60" />
										) : null}
									</div>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
