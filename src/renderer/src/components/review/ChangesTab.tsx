// FILE: ChangesTab.tsx
// Purpose: The Changes tab: tick the files to include, write a message, commit — with
//          the diff of the selected file alongside, as in GitHub Desktop.
// Layer: Review workbench

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile } from "../../../../shared/git";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { CheckIcon, GitCommitIcon, RotateCcwIcon, Undo2Icon } from "../../lib/icons";
import { cn, isMacPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { ContextMenu, type ContextMenuState } from "../ui/context-menu";
import { IconButton } from "../ui/icon-button";
import { Spinner } from "../ui/spinner";
import { gitLetter } from "../ide/git-decorations";
import { DiffViewer } from "./DiffViewer";
import { FileRow } from "./FileRow";
import { branchLabel } from "./BranchPicker";
import { copyText } from "./format";
import { useAsync } from "./hooks";
import { SplitPane } from "./SplitPane";
import type { CommitDraft, TabProps } from "./types";

/** Soft limit GitHub Desktop also shows: summaries longer than this get cut off in most tools. */
const SUMMARY_SOFT_LIMIT = 72;

const FIELD =
	"review-commit-field w-full rounded-md border border-[color:var(--color-border)] px-2 text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground/60 focus:border-[color:var(--color-border-focus)] disabled:opacity-60";

type DiscardTarget = { files: string[] | null; label: string; count: number };

export function ChangesTab({
	cwd,
	status,
	prefs,
	onPrefs,
	tabs,
	onChanged,
	onError,
	onNotice,
	onSelectTab,
	draft,
	setDraft,
}: TabProps & { draft: CommitDraft; setDraft: (patch: Partial<CommitDraft>) => void }) {
	const { t, language } = useTranslation();
	const files = status.files;
	const merging = status.merging === true;
	const excluded = useMemo(() => new Set(draft.excluded), [draft.excluded]);
	const included = merging ? files : files.filter((file) => !excluded.has(file.path));
	const allIncluded = included.length === files.length;

	const [selected, setSelected] = useState<string | null>(null);
	const [busy, setBusy] = useState<"commit" | "undo" | "discard" | "generate" | null>(null);
	const generation = useRef(0);
	const generationContext = JSON.stringify([cwd, language, draft, included.map(({ path, oldPath, status, additions, deletions }) =>
		({ path, oldPath, status, additions, deletions }))]);
	const latestGenerationContext = useRef(generationContext);
	latestGenerationContext.current = generationContext;
	useEffect(() => {
		setBusy(current => current === "generate" ? null : current);
		return () => { generation.current++; };
	}, [cwd]);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [discard, setDiscard] = useState<DiscardTarget | null>(null);

	useEffect(() => {
		setSelected((current) => (current && files.some((file) => file.path === current) ? current : (files[0]?.path ?? null)));
	}, [files]);

	const current = files.find((file) => file.path === selected) ?? null;
	// Re-read the diff when the file's own numbers change, not on every unrelated status poll.
	const fingerprint = current ? `${current.status}:${String(current.additions)}:${String(current.deletions)}` : "";
	const diff = useAsync(
		current
			? () => api.gitDiff({ cwd, scope: "head", file: current.path, ...(current.oldPath ? { oldPath: current.oldPath } : {}), ignoreWhitespace: prefs.ignoreWhitespace })
			: null,
		[cwd, current?.path, current?.oldPath, fingerprint, prefs.ignoreWhitespace],
		`${cwd}:${current?.path ?? ""}`,
	);

	const toggle = useCallback(
		(path: string, on: boolean) => {
			const next = new Set(draft.excluded);
			if (on) next.delete(path);
			else next.add(path);
			setDraft({ excluded: [...next] });
		},
		[draft.excluded, setDraft],
	);

	const summary = draft.summary.trim();
	const canCommit = busy === null && summary.length > 0 && (included.length > 0 || draft.amend);
	const generating = busy === "generate";

	const generateMessage = async () => {
		if (busy !== null || included.length === 0) return;
		const id = ++generation.current;
		const context = generationContext;
		setBusy("generate");
		try {
			const result = await api.gitGenerateCommitMessage({ cwd, files: included.map(file => file.path), language });
			if (id !== generation.current) return;
			if (latestGenerationContext.current !== context) {
				onNotice(t("review.commit.generateStale"));
				return;
			}
			setDraft({ summary: result.summary, description: result.description });
			if (result.truncated) onNotice(t("review.commit.generateTruncated"));
		} catch (cause) {
			if (id === generation.current) onError(errorMessage(cause));
		} finally {
			if (id === generation.current) setBusy(null);
		}
	};

	const commit = async () => {
		if (!canCommit) return;
		setBusy("commit");
		try {
			const paths = included.flatMap((file) => (file.oldPath ? [file.oldPath, file.path] : [file.path]));
			const result = await api.gitCommit({
				cwd,
				summary: draft.summary,
				description: draft.description,
				...(allIncluded && !draft.amend ? {} : { files: paths }),
				...(draft.amend ? { amend: true } : {}),
			});
			setDraft({ summary: "", description: "", amend: false, excluded: [] });
			onNotice(t("review.commit.done", { hash: result.shortHash, branch }));
			await onChanged();
		} catch (cause) {
			onError(t("review.commit.failed", { message: errorMessage(cause) }));
		} finally {
			setBusy(null);
		}
	};

	const undo = async () => {
		setBusy("undo");
		try {
			const result = await api.gitUndoCommit(cwd);
			setDraft({ summary: result.summary, description: result.description, amend: false });
			onNotice(t("review.commit.undone"));
			await onChanged();
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setBusy(null);
		}
	};

	const toggleAmend = async (on: boolean) => {
		if (!on) {
			setDraft({ amend: false });
			return;
		}
		setDraft({ amend: true });
		const last = status.lastCommit;
		if (!last || draft.summary.trim()) return;
		try {
			const detail = await api.gitCommitDetail(cwd, last.hash);
			setDraft({ summary: detail.commit.subject, description: detail.body });
		} catch {
			setDraft({ summary: last.subject });
		}
	};

	const confirmDiscard = async () => {
		const target = discard;
		setDiscard(null);
		if (!target) return;
		setBusy("discard");
		try {
			await api.gitDiscard({ cwd, ...(target.files ? { files: target.files } : {}) });
			if (target.files) setDraft({ excluded: draft.excluded.filter((path) => !target.files!.includes(path)) });
			else setDraft({ excluded: [] });
			await onChanged();
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setBusy(null);
		}
	};

	const openMenu = (event: React.MouseEvent, file: ChangedFile) => {
		event.preventDefault();
		const ticked = files.filter((entry) => !excluded.has(entry.path));
		const items: ContextMenuState["items"] = [
			{
				label: t("review.discard.menu"),
				danger: true,
				onSelect: () => setDiscard({ files: [file.path], label: file.path, count: 1 }),
			},
		];
		if (ticked.length > 1 && ticked.some((entry) => entry.path === file.path)) {
			items.push({
				label: t("review.discard.selected"),
				danger: true,
				onSelect: () => setDiscard({ files: ticked.map((entry) => entry.path), label: "", count: ticked.length }),
			});
		}
		items.push({ kind: "separator" }, { label: t("review.file.copyPath"), onSelect: () => void copyText(file.path) });
		setMenu({ x: event.clientX, y: event.clientY, items });
	};

	const modKey = isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform) ? "⌘" : "Ctrl";
	const onFieldKey = (event: React.KeyboardEvent) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void commit();
		}
	};
	const branch = branchLabel(status, t);
	const last = status.lastCommit;

	const sidebar = (
		<div className="flex min-h-[24rem] flex-1 flex-col">
			{tabs}
			{status.merging ? (
				<div className="flex shrink-0 flex-col gap-1.5 border-b border-[color:var(--app-surface-divider)] px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					<span>{t("review.merge.banner")}</span>
					<Button
						size="xs"
						variant="chrome-outline"
						className="self-start"
						disabled={busy !== null}
						onClick={() => void api.gitAbortMerge(cwd).then(onChanged, (cause: unknown) => onError(errorMessage(cause)))}
					>
						{t("review.merge.abort")}
					</Button>
				</div>
			) : null}
			<div className="flex h-8 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<Checkbox
					aria-label={t("review.changes.selectAll")}
					checked={files.length > 0 && allIncluded}
					indeterminate={included.length > 0 && !allIncluded}
					disabled={files.length === 0 || merging || busy !== null}
					onCheckedChange={(on) => setDraft({ excluded: on === true ? [] : files.map((file) => file.path) })}
				/>
				<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)] font-medium">
					{files.length === 1 ? t("review.files.one") : t("review.files.many", { count: files.length })}
				</span>
				{files.length > 0 ? (
					<IconButton
						label={t("review.discard.everything")}
						tooltip={t("review.discard.everything")}
						disabled={busy !== null}
						onClick={() => setDiscard({ files: null, label: "", count: files.length })}
					>
						<RotateCcwIcon />
					</IconButton>
				) : null}
			</div>
			<div role="listbox" aria-multiselectable className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
				{files.length === 0 ? (
					<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.noFiles")}</p>
				) : (
					files.map((file) => (
						<FileRow
							key={file.path}
							path={file.path}
							{...(file.oldPath ? { oldPath: file.oldPath } : {})}
							letter={gitLetter(file.status)}
							additions={file.additions}
							deletions={file.deletions}
							selected={file.path === selected}
							onSelect={() => setSelected(file.path)}
							onContextMenu={(event) => openMenu(event, file)}
							checked={merging || !excluded.has(file.path)}
							checkDisabled={merging || busy !== null}
							onCheckedChange={(on) => toggle(file.path, on)}
						/>
					))
				)}
				{status.truncated ? (
					<p className="px-2 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t("review.changes.truncated", { count: files.length })}
					</p>
				) : null}
			</div>

			<div className="flex shrink-0 flex-col gap-1.5 border-t border-[color:var(--app-surface-divider)] p-2.5">
				<div className="flex items-center justify-between gap-2">
					<span className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium">{t("review.commit.message")}</span>
					<Button size="xs" variant="chrome-outline" disabled={busy !== null || included.length === 0}
						onClick={() => void generateMessage()} title={t("review.commit.generateHint")} aria-busy={generating}>
						{generating ? <Spinner className="size-3" /> : null}
						{t(generating ? "review.commit.generating" : "review.commit.generate")}
					</Button>
				</div>
				<div className="relative">
					<input
						value={draft.summary}
						onChange={(event) => setDraft({ summary: event.target.value })}
						onKeyDown={onFieldKey}
						placeholder={t("review.commit.summary")}
						disabled={busy === "commit" || generating}
						spellCheck
						className={cn(FIELD, "h-8 pr-10", draft.summary.length > SUMMARY_SOFT_LIMIT && "border-[var(--warning)]")}
					/>
					{draft.summary.length > SUMMARY_SOFT_LIMIT - 12 ? (
						<span
							className={cn(
								"pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[length:var(--app-font-size-ui-2xs,9px)] tabular-nums",
								draft.summary.length > SUMMARY_SOFT_LIMIT ? "text-[var(--warning)]" : "text-muted-foreground",
							)}
						>
							{draft.summary.length}
						</span>
					) : null}
				</div>
				<textarea
					value={draft.description}
					onChange={(event) => setDraft({ description: event.target.value })}
					onKeyDown={onFieldKey}
					placeholder={t("review.commit.description")}
					disabled={busy === "commit" || generating}
					rows={2}
					className={cn(FIELD, "resize-none py-1.5")}
				/>
				{status.lastCommit && !status.lastCommit.pushed ? (
					<label className="flex cursor-pointer items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						<Checkbox checked={draft.amend} disabled={busy !== null} onCheckedChange={(on) => void toggleAmend(on === true)} />
						{t("review.commit.amend")}
					</label>
				) : null}
				{merging ? (
					<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("review.commit.mergeNote")}</p>
				) : null}
				<Button
					disabled={!canCommit}
					aria-busy={busy === "commit"}
					onClick={() => void commit()}
					title={t("review.commit.shortcut", { key: modKey })}
					className="w-full"
				>
					{busy === "commit" ? <Spinner className="size-3.5" /> : draft.amend ? <CheckIcon /> : <GitCommitIcon />}
					<span className="min-w-0 truncate">
						{busy === "commit"
							? t("review.commit.committing")
							: draft.amend
								? t("review.commit.buttonAmend")
								: t("review.commit.button", { branch })}
					</span>
				</Button>
				{files.length > 0 && included.length === 0 && !draft.amend ? (
					<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("review.commit.needFiles")}</p>
				) : null}
			</div>

			{last ? (
				<div className="flex shrink-0 items-center gap-2 border-t border-[color:var(--app-surface-divider)] px-3 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)]">
					<div className="min-w-0 flex-1">
						<div className="text-muted-foreground">{t("review.commit.last")}</div>
						<div className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-foreground" title={last.subject}>
							{last.subject}
						</div>
					</div>
					{!last.pushed ? (
						<Button size="xs" variant="chrome-outline" disabled={busy !== null} onClick={() => void undo()}>
							{busy === "undo" ? <Spinner className="size-3" /> : <Undo2Icon />}
							{t("review.commit.undo")}
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);

	const main =
		files.length === 0 ? (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
				<div className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">{t("review.changes.none")}</div>
				<p className="max-w-sm text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.changes.noneHint")}</p>
				<div className="flex gap-2">
					<Button size="sm" variant="chrome-outline" onClick={() => onSelectTab("history")}>
						{t("review.tab.history")}
					</Button>
					<Button size="sm" variant="chrome-outline" onClick={() => onSelectTab("compare")}>
						{t("review.tab.compare")}
					</Button>
				</div>
			</div>
		) : (
			<DiffViewer
				patch={diff.error ? "" : (diff.data ?? "")}
				loading={diff.loading}
				path={current?.path ?? null}
				prefs={prefs}
				onPrefs={onPrefs}
				actions={
					current ? (
						<IconButton
							label={t("review.discard.menu")}
							tooltip={t("review.discard.menu")}
							disabled={busy !== null}
							onClick={() => setDiscard({ files: [current.path], label: current.path, count: 1 })}
						>
							<RotateCcwIcon />
						</IconButton>
					) : null
				}
			/>
		);

	return (
		<>
			<SplitPane sidebar={sidebar} main={main} />
			<ContextMenu menu={menu} onClose={() => setMenu(null)} />
			<ConfirmDialog
				open={discard !== null}
				onOpenChange={(open) => {
					if (!open) setDiscard(null);
				}}
				title={t("review.discard.title")}
				description={
					discard === null
						? undefined
						: discard.files === null
							? t("review.discard.all", { count: discard.count })
							: discard.count === 1
								? t("review.discard.one", { name: discard.label })
								: t("review.discard.many", { count: discard.count })
				}
				footer={
					<>
						<Button onClick={() => setDiscard(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button autoFocus onClick={() => void confirmDiscard()} size="sm" variant="destructive">
							{t("review.discard.confirm")}
						</Button>
					</>
				}
			>
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.discard.warning")}</p>
			</ConfirmDialog>
		</>
	);
}
