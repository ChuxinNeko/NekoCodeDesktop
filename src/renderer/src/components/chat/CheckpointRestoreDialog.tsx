import { useEffect, useState } from "react";
import type {
	CheckpointDiff,
	CheckpointScope,
	CheckpointSummary,
} from "../../../../shared/checkpoints";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslateFn } from "../../i18n";
import { CircleAlertIcon, DiffIcon, PlusIcon, Trash2, Undo2Icon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { DiffStat } from "../ui/diff-stat";
import { Spinner } from "../ui/spinner";

/** A scope the user can actually pick, given what this checkpoint still holds. */
function availableScopes(checkpoint: CheckpointSummary): CheckpointScope[] {
	const scopes: CheckpointScope[] = [];
	if (checkpoint.codeRestorable && checkpoint.conversationRestorable) scopes.push("both");
	if (checkpoint.codeRestorable) scopes.push("code");
	if (checkpoint.conversationRestorable) scopes.push("conversation");
	return scopes;
}

const SCOPE_LABELS: Record<CheckpointScope, "checkpoint.scopeBoth" | "checkpoint.scopeCode" | "checkpoint.scopeConversation"> = {
	both: "checkpoint.scopeBoth",
	code: "checkpoint.scopeCode",
	conversation: "checkpoint.scopeConversation",
};

const SCOPE_HINTS: Record<CheckpointScope, "checkpoint.scopeBothHint" | "checkpoint.scopeCodeHint" | "checkpoint.scopeConversationHint"> = {
	both: "checkpoint.scopeBothHint",
	code: "checkpoint.scopeCodeHint",
	conversation: "checkpoint.scopeConversationHint",
};

function ScopeOption({
	scope,
	selected,
	onSelect,
	t,
}: {
	scope: CheckpointScope;
	selected: boolean;
	onSelect: () => void;
	t: TranslateFn;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			onClick={onSelect}
			className={cn(
				"flex w-full flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
				selected
					? "border-[color:var(--color-border-focus)] bg-[var(--color-background-elevated-secondary)]"
					: "border-[color:var(--app-surface-divider)] hover:bg-[var(--color-background-elevated-secondary)]",
			)}
		>
			<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
				{t(SCOPE_LABELS[scope])}
			</span>
			<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
				{t(SCOPE_HINTS[scope])}
			</span>
		</button>
	);
}

const ACTION_ICONS = {
	overwrite: DiffIcon,
	recreate: PlusIcon,
	delete: Trash2,
} as const;

/**
 * The files a restore would touch, so "回退" is a decision made against a list
 * rather than a promise.
 *
 * Deletions are called out in the destructive tone because they are the only
 * action here that can lose work the checkpoint never had — a file written after
 * it and not saved anywhere else.
 */
function DiffList({ diff, t }: { diff: CheckpointDiff; t: TranslateFn }) {
	if (diff.total === 0) {
		return (
			<p className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
				{t("checkpoint.noFileChanges")}
			</p>
		);
	}
	return (
		<div className="flex min-h-0 flex-col gap-1">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[length:var(--app-font-size-ui-sm,11px)]">
				{diff.counts.overwrite > 0 ? (
					<span>{t("checkpoint.countOverwrite", { count: diff.counts.overwrite })}</span>
				) : null}
				{diff.counts.recreate > 0 ? (
					<span>{t("checkpoint.countRecreate", { count: diff.counts.recreate })}</span>
				) : null}
				{diff.counts.delete > 0 ? (
					<span className="text-destructive">
						{t("checkpoint.countDelete", { count: diff.counts.delete })}
					</span>
				) : null}
				<span className="flex-1" />
				<DiffStat insertions={diff.additions} deletions={diff.deletions} />
			</div>
			<ul className="flex max-h-44 flex-col gap-px overflow-y-auto rounded-lg border border-[color:var(--app-surface-divider)] p-1">
				{diff.changes.map((change) => {
					const Icon = ACTION_ICONS[change.action];
					return (
						<li
							key={`${change.action}:${change.path}`}
							className="flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)]"
						>
							<Icon
								className={cn(
									"size-3 shrink-0",
									change.action === "delete" ? "text-destructive" : "opacity-60",
								)}
							/>
							<span className="min-w-0 flex-1 truncate" title={change.path}>
								{change.path}
							</span>
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
						</li>
					);
				})}
				{diff.truncated ? (
					<li className={cn("px-1 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						{t("checkpoint.andMore", { count: diff.total - diff.changes.length })}
					</li>
				) : null}
			</ul>
		</div>
	);
}

export interface CheckpointRestoreDialogProps {
	checkpoint: CheckpointSummary | null;
	onClose: () => void;
	/** Runs after a confirmed restore; carries the prompt back to the composer. */
	onRestored: (result: { editorText?: string; warnings: string[] }) => void;
	onError: (message: string) => void;
}

/**
 * Confirm a rewind, and say what it would cost first.
 *
 * The preview is fetched when the dialog opens rather than kept on the snapshot,
 * because it is a comparison against the working tree as it is *now* — the same
 * checkpoint means something different a minute later, and a number computed at
 * checkpoint time would be a stale claim about the user's files.
 */
export function CheckpointRestoreDialog({
	checkpoint,
	onClose,
	onRestored,
	onError,
}: CheckpointRestoreDialogProps) {
	const { t } = useTranslation();
	const [scope, setScope] = useState<CheckpointScope>("both");
	const [diff, setDiff] = useState<CheckpointDiff | null>(null);
	const [loading, setLoading] = useState(false);
	const [restoring, setRestoring] = useState(false);

	const scopes = checkpoint ? availableScopes(checkpoint) : [];

	// Re-fetched per checkpoint: the diff is against the tree right now.
	useEffect(() => {
		if (!checkpoint) return;
		setScope(scopes[0] ?? "conversation");
		setDiff(null);
		if (!checkpoint.codeRestorable) return;
		let cancelled = false;
		setLoading(true);
		api
			.checkpointPreview(checkpoint.id)
			.then((preview) => {
				if (!cancelled) setDiff(preview.diff);
			})
			.catch((cause) => {
				if (!cancelled) onError(errorMessage(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
		// Keyed on the checkpoint alone: the preview is a question about one
		// checkpoint, and re-running it because a callback identity changed would
		// re-fetch a file listing while the user is reading it.
	}, [checkpoint?.id]);

	if (!checkpoint) return null;

	const confirm = async () => {
		setRestoring(true);
		try {
			const result = await api.checkpointRestore({ id: checkpoint.id, scope });
			onRestored({ editorText: result.editorText, warnings: result.warnings });
			onClose();
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setRestoring(false);
		}
	};

	const touchesCode = scope !== "conversation";

	return (
		<ConfirmDialog
			wide
			open
			onOpenChange={(next) => {
				if (!next && !restoring) onClose();
			}}
			title={t("checkpoint.restoreTitle")}
			description={t("checkpoint.restoreDescription", { label: checkpoint.label })}
			footer={
				<>
					<Button disabled={restoring} onClick={onClose} size="sm" variant="subtle">
						{t("common.cancel")}
					</Button>
					<Button
						autoFocus
						disabled={restoring || scopes.length === 0}
						onClick={() => void confirm()}
						size="sm"
						variant={diff && diff.counts.delete > 0 && touchesCode ? "destructive" : "default"}
					>
						{restoring ? <Spinner className="size-3.5" /> : <Undo2Icon className="size-3.5" />}
						{t("checkpoint.confirmRestore")}
					</Button>
				</>
			}
		>
			{scopes.length === 0 ? (
				<p className="flex items-start gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					<CircleAlertIcon className="mt-px size-3.5 shrink-0" />
					{t("checkpoint.nothingRestorable")}
				</p>
			) : (
				<div className="flex flex-col gap-2" role="radiogroup" aria-label={t("checkpoint.scopeLabel")}>
					{scopes.map((option) => (
						<ScopeOption
							key={option}
							scope={option}
							selected={scope === option}
							onSelect={() => setScope(option)}
							t={t}
						/>
					))}
				</div>
			)}

			{/* A shell command announces a command line, not a file list, so whatever
			    it changed was never recorded and will survive the restore. Said out
			    loud, because "restored" has to mean the same thing every time. */}
			{touchesCode && diff && diff.shellRuns > 0 ? (
				<p className="flex items-start gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					<CircleAlertIcon className="mt-px size-3.5 shrink-0" />
					{t("checkpoint.shellWarning", { count: diff.shellRuns })}
				</p>
			) : null}
			{touchesCode && diff && diff.unrestorable.length > 0 ? (
				<p className="flex items-start gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					<CircleAlertIcon className="mt-px size-3.5 shrink-0" />
					{t("checkpoint.unrestorableWarning", { count: diff.unrestorable.length })}
				</p>
			) : null}

			{touchesCode && scopes.length > 0 ? (
				loading ? (
					<div
						className={cn(
							"flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						<Spinner className="size-3.5" />
						{t("checkpoint.loadingPreview")}
					</div>
				) : diff ? (
					<DiffList diff={diff} t={t} />
				) : null
			) : null}
		</ConfirmDialog>
	);
}
