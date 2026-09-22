import { useCallback, useEffect, useState } from "react";
import type { WorktreeStatus } from "../../../../shared/worktree";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { GitBranchIcon, GitMergeIcon, TrashCanIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";

interface WorktreeBarProps {
	sessionId: string;
	/** The session's title, which is what an unattended task's commit gets named. */
	title: string;
	/** A run in flight is still writing files; merging under it would race. */
	streaming: boolean;
	/** The worktree is gone — whatever pointed at this session has to re-read. */
	onReleased: () => void;
	onError: (message: string) => void;
}

/**
 * The strip that says this session is working on a branch of its own.
 *
 * Only a background task started under isolation has one. It is the only place
 * that work becomes reachable from the main checkout, so it has to be on screen
 * whenever the session is — a branch the user never learns about is the same as
 * losing the task's output.
 */
export function WorktreeBar(props: WorktreeBarProps) {
	const { t } = useTranslation();
	const { sessionId, streaming } = props;
	const [status, setStatus] = useState<WorktreeStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);

	const refresh = useCallback(() => {
		let cancelled = false;
		api
			.worktreeStatus(sessionId)
			.then((next) => {
				if (!cancelled) setStatus(next);
			})
			.catch(() => {
				if (!cancelled) setStatus(null);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// Re-read when the run settles: a finished task is exactly when the file
	// count changed and when the user is most likely to act on it.
	useEffect(() => refresh(), [refresh, streaming]);

	if (!status) return null;
	const { record, dirtyFiles, ahead, missing } = status;

	const merge = () => {
		setBusy(true);
		api
			.worktreeMerge({ sessionId, message: props.title })
			.then((result) => {
				if (result.merged) props.onReleased();
				else props.onError(result.reason);
				refresh();
			})
			.catch((cause: unknown) => props.onError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const discard = () => {
		setConfirmingDiscard(false);
		setBusy(true);
		api
			.worktreeDiscard(sessionId)
			.then(() => props.onReleased())
			.catch((cause: unknown) => props.onError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const changes = missing
		? t("worktree.missing")
		: t("worktree.changes", { files: dirtyFiles, commits: ahead });

	return (
		<div className="flex items-center gap-2 border-b border-[color:var(--app-surface-divider)] bg-[var(--color-background-elevated-secondary)] px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
			<GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="shrink-0 truncate font-mono text-foreground">{record.branch}</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground">
				{t("worktree.base", { base: record.base })} · {changes}
			</span>
			<Button
				disabled={busy || streaming || missing || (dirtyFiles === 0 && ahead === 0)}
				onClick={merge}
				size="xs"
				title={streaming ? t("worktree.mergeWhileRunning") : undefined}
				variant="chrome-outline"
			>
				<GitMergeIcon className="size-3.5" />
				{t("worktree.merge", { base: record.base })}
			</Button>
			<Button
				disabled={busy || streaming}
				onClick={() => setConfirmingDiscard(true)}
				size="xs"
				variant="chrome-outline"
			>
				<TrashCanIcon className="size-3.5" />
				{t("worktree.discard")}
			</Button>

			<ConfirmDialog
				open={confirmingDiscard}
				onOpenChange={setConfirmingDiscard}
				title={t("worktree.discardTitle")}
				description={t("worktree.discardBody", { branch: record.branch, files: dirtyFiles })}
				footer={
					<>
						<Button onClick={() => setConfirmingDiscard(false)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button onClick={discard} size="sm" variant="destructive">
							{t("worktree.discard")}
						</Button>
					</>
				}
			/>
		</div>
	);
}
