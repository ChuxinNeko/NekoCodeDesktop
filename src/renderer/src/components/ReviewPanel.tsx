// FILE: ReviewPanel.tsx
// Purpose: The review workbench, laid out like GitHub Desktop: a toolbar with the
//          repository, branch picker and sync button, and Changes / History / Compare
//          tabs, each a list beside a diff. Used full-window and docked beside the chat.
// Layer: Review workbench

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCommit, GitRemoteActionKind } from "../../../shared/git";
import { api, errorMessage } from "../api";
import { useTranslation } from "../i18n";
import { CircleCheckIcon, FolderOpenIcon, RefreshCwIcon, XIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { BranchPicker } from "./review/BranchPicker";
import { ChangesTab } from "./review/ChangesTab";
import { CompareTab } from "./review/CompareTab";
import { HistoryTab } from "./review/HistoryTab";
import { SyncButton } from "./review/SyncButton";
import { useDiffPrefs, usePersistentState, useRepoStatus } from "./review/hooks";
import { EMPTY_DRAFT, type CommitDraft, type ReviewTab, type TabProps } from "./review/types";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Spinner } from "./ui/spinner";

const TABS: ReviewTab[] = ["changes", "history", "compare"];
const isTab = (value: unknown): value is ReviewTab => typeof value === "string" && (TABS as string[]).includes(value);

/** How long a success message stays before it fades. */
const NOTICE_MS = 8000;

export function ReviewPanel({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
	const { t } = useTranslation();
	const { status, loading, error, setError, refresh } = useRepoStatus(cwd);
	const [tab, setTab] = usePersistentState<ReviewTab>("nekocode:review:tab", "changes", isTab);
	const [prefs, setPrefs] = useDiffPrefs();
	const [draft, setDraftState] = useState<CommitDraft>(EMPTY_DRAFT);
	const [notice, setNotice] = useState<string | null>(null);
	const [syncing, setSyncing] = useState<GitRemoteActionKind | null>(null);
	const [createFrom, setCreateFrom] = useState<{ hash: string; label: string } | null>(null);
	const noticeTimer = useRef<number | null>(null);
	const syncRequest = useRef<symbol | null>(null);

	// A different project is a different commit message.
	useEffect(() => {
		setDraftState(EMPTY_DRAFT);
		setSyncing(null);
		setNotice(null);
		if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
		return () => { syncRequest.current = null; };
	}, [cwd]);
	useEffect(
		() => () => {
			if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
		},
		[],
	);

	const setDraft = useCallback((patch: Partial<CommitDraft>) => setDraftState((current) => ({ ...current, ...patch })), []);
	const onError = useCallback((message: string) => setError(message), [setError]);
	const onNotice = useCallback((message: string) => {
		setError(null);
		setNotice(message);
		if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
		noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
	}, [setError]);
	const onChanged = useCallback(async () => {
		setError(null);
		await refresh();
	}, [refresh, setError]);
	const onCreateFromHandled = useCallback(() => setCreateFrom(null), []);

	const sync = async (action: GitRemoteActionKind) => {
		if (!cwd || syncRequest.current !== null) return;
		const request = Symbol();
		syncRequest.current = request;
		const remote = status?.remote ?? "origin";
		setSyncing(action);
		setError(null);
		setNotice(null);
		try {
			await api.gitRemoteAction({ cwd, action });
			if (syncRequest.current !== request) return;
			onNotice(t(`review.sync.${action}Done`, { remote }));
		} catch (cause) {
			if (syncRequest.current === request) setError(t(`review.sync.${action}Failed`, { message: errorMessage(cause) }));
		} finally {
			if (syncRequest.current === request) {
				await refresh();
				if (syncRequest.current === request) {
					syncRequest.current = null;
					setSyncing(null);
				}
			}
		}
	};

	const body = () => {
		if (!cwd) {
			return <p className="p-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.openProject")}</p>;
		}
		if (!status) {
			return (
				<div className="flex flex-1 items-center justify-center">
					<Spinner className="size-4 text-muted-foreground" />
				</div>
			);
		}
		if (!status.gitAvailable) {
			return (
				<div className="flex flex-col items-start gap-2 p-3">
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">{status.gitError ?? t("review.gitUnavailable")}</p>
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.gitUnavailableHint")}</p>
				</div>
			);
		}
		if (!status.isRepo) {
			return (
				<div className="flex flex-col items-start gap-2 p-3">
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.notRepo")}</p>
					<Button
						onClick={() => void api.gitInit(cwd).then(refresh, (cause: unknown) => setError(errorMessage(cause)))}
						size="sm"
						variant="subtle"
					>
						{t("review.initRepo")}
					</Button>
				</div>
			);
		}

		const tabs = (
			<div role="tablist" className="flex h-9 shrink-0 items-stretch border-b border-[color:var(--app-surface-divider)] px-1">
				{TABS.map((id) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						onClick={() => setTab(id)}
						className={cn(
							"relative flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-[length:var(--app-font-size-ui-sm,11px)] font-medium outline-none transition-colors",
							"after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors",
							tab === id ? "text-foreground after:bg-[var(--color-text-accent)]" : "text-muted-foreground after:bg-transparent hover:text-foreground",
						)}
					>
						<span className="truncate">{t(`review.tab.${id}` as const)}</span>
						{id === "changes" && status.files.length > 0 ? (
							<span className="rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] tabular-nums">
								{status.files.length}
							</span>
						) : null}
					</button>
				))}
			</div>
		);
		const common: TabProps = {
			cwd,
			status,
			prefs,
			onPrefs: setPrefs,
			tabs,
			onChanged,
			onError,
			onNotice,
			onSelectTab: setTab,
		};
		if (tab === "history") {
			return <HistoryTab {...common} onBranchFrom={(commit: GitCommit) => setCreateFrom({ hash: commit.hash, label: `${commit.shortHash} ${commit.subject}` })} />;
		}
		if (tab === "compare") return <CompareTab {...common} />;
		return <ChangesTab {...common} draft={draft} setDraft={setDraft} />;
	};

	const ready = cwd !== null && status !== null && status.gitAvailable && status.isRepo;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[color:var(--app-surface-divider)] px-3 py-1.5">
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("review.title")}</span>
				{ready && status ? (
					<>
						{status.repoName ? (
							<span
								title={`${t("review.repo")}: ${cwd}`}
								className="inline-flex h-7 max-w-48 min-w-0 items-center gap-1.5 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground"
							>
								<FolderOpenIcon className="size-3.5 shrink-0 opacity-80" />
								<span className="truncate">{status.repoName}</span>
							</span>
						) : null}
						<BranchPicker
							cwd={cwd}
							status={status}
							onChanged={onChanged}
							onError={onError}
							createFrom={createFrom}
							onCreateFromHandled={onCreateFromHandled}
						/>
						<SyncButton status={status} busy={syncing} onRun={(action) => void sync(action)} />
					</>
				) : null}
				<div className="flex-1" />
				{loading && status ? <Spinner className="size-3 text-muted-foreground" /> : null}
				<IconButton label={t("common.refresh")} tooltip={t("common.refresh")} onClick={() => void refresh()}>
					<RefreshCwIcon />
				</IconButton>
				<IconButton label={t("common.close")} tooltip={t("common.close")} onClick={onClose}>
					<XIcon />
				</IconButton>
			</header>
			{syncing ? (
				<div role="status" aria-live="polite" className="flex shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					<Spinner className="size-3.5 shrink-0" />
					{t(`review.sync.${syncing}Working`, { remote: status?.remote ?? "origin" })}
				</div>
			) : null}

			{error ? (
				<div
					role="alert"
					className="flex shrink-0 items-start gap-2 border-b border-[color:var(--app-surface-divider)] bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive"
				>
					<span className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">{error}</span>
					<button type="button" aria-label={t("common.close")} onClick={() => setError(null)} className="mt-0.5 shrink-0 opacity-80 hover:opacity-100">
						<XIcon className="size-3.5" />
					</button>
				</div>
			) : null}
			{notice ? (
				<div
					role="status"
					aria-live="polite"
					className="flex shrink-0 items-start gap-2 border-b border-[color:var(--app-surface-divider)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-success"
				>
					<CircleCheckIcon className="size-3.5 shrink-0" />
					<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{notice}</span>
					<button type="button" aria-label={t("common.close")} onClick={() => {
						if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
						setNotice(null);
					}} className="shrink-0 opacity-80 hover:opacity-100"><XIcon className="size-3.5" /></button>
				</div>
			) : null}

			{body()}
		</div>
	);
}
