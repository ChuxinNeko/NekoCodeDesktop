// FILE: HistoryTab.tsx
// Purpose: The History tab: the current branch's commits, searchable, with each commit's
//          files and diff, plus copy / branch-from-here / revert.
// Layer: Review workbench

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCommit } from "../../../../shared/git";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { CopyIcon, GitBranchIcon, SearchIcon, Undo2Icon } from "../../lib/icons";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Spinner } from "../ui/spinner";
import { branchLabel } from "./BranchPicker";
import { CommitFilesView } from "./CommitFilesView";
import { CommitList, CommitRow } from "./CommitList";
import { absoluteTime, copyText, initials, visibleRefs } from "./format";
import { useAsync } from "./hooks";
import { SplitPane } from "./SplitPane";
import type { TabProps } from "./types";

const PAGE = 60;

export function HistoryTab({
	cwd,
	status,
	prefs,
	onPrefs,
	tabs,
	onChanged,
	onError,
	onNotice,
	onBranchFrom,
}: TabProps & { onBranchFrom: (commit: GitCommit) => void }) {
	const { t, language } = useTranslation();
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [commits, setCommits] = useState<GitCommit[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [reverting, setReverting] = useState<GitCommit | null>(null);
	const [copied, setCopied] = useState(false);
	const generation = useRef(0);

	useEffect(() => {
		const timer = window.setTimeout(() => setSearch(query.trim()), 250);
		return () => window.clearTimeout(timer);
	}, [query]);

	// The commit list changes when the branch moves, when something is pulled, or the search changes.
	const headKey = `${status.branch ?? ""}:${status.lastCommit?.hash ?? ""}:${String(status.ahead ?? 0)}:${String(status.behind ?? 0)}`;
	useEffect(() => {
		const ticket = ++generation.current;
		setLoading(true);
		api.gitLog({ cwd, limit: PAGE, ...(search ? { search } : {}) }).then(
			(result) => {
				if (ticket !== generation.current) return;
				setCommits(result.commits);
				setHasMore(result.hasMore);
				setSelected((current) => (current && result.commits.some((commit) => commit.hash === current) ? current : (result.commits[0]?.hash ?? null)));
			},
			(cause: unknown) => {
				if (ticket === generation.current) onError(errorMessage(cause));
			},
		).finally(() => {
			if (ticket === generation.current) setLoading(false);
		});
	}, [cwd, search, headKey]); // eslint-disable-line react-hooks/exhaustive-deps -- onError is stable enough; re-running on it would refetch needlessly

	const loadMore = useCallback(async () => {
		const ticket = generation.current;
		setLoadingMore(true);
		try {
			const result = await api.gitLog({ cwd, limit: PAGE, skip: commits.length, ...(search ? { search } : {}) });
			if (ticket !== generation.current) return;
			setCommits((existing) => [...existing, ...result.commits.filter((commit) => !existing.some((known) => known.hash === commit.hash))]);
			setHasMore(result.hasMore);
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setLoadingMore(false);
		}
	}, [cwd, search, commits.length, onError]);

	const detail = useAsync(
		selected ? () => api.gitCommitDetail(cwd, selected) : null,
		[cwd, selected],
		selected ?? "",
	);

	const revert = async () => {
		const commit = reverting;
		setReverting(null);
		if (!commit) return;
		try {
			await api.gitRevertCommit(cwd, commit.hash);
			onNotice(t("review.commitDetail.reverted", { hash: commit.shortHash }));
			await onChanged();
		} catch (cause) {
			onError(errorMessage(cause));
		}
	};

	const sidebar = (
		<div className="flex min-h-0 flex-1 flex-col">
			{tabs}
			<div className="relative shrink-0 border-b border-[color:var(--app-surface-divider)] p-2">
				<SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("review.history.search")}
					className="h-7 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] pl-7 pr-2 text-[length:var(--app-font-size-ui-sm,11px)] outline-none placeholder:text-muted-foreground/60 focus:border-[color:var(--color-border-focus)]"
				/>
			</div>
			<CommitList>
				{loading && commits.length === 0 ? (
					<div className="flex justify-center p-4"><Spinner className="size-4 text-muted-foreground" /></div>
				) : commits.length === 0 ? (
					<p className="px-2 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{search ? t("review.history.noMatch") : t("review.history.empty")}
					</p>
				) : (
					commits.map((commit) => (
						<CommitRow key={commit.hash} commit={commit} selected={commit.hash === selected} onSelect={() => setSelected(commit.hash)} />
					))
				)}
				{hasMore ? (
					<div className="flex justify-center p-2">
						<Button size="xs" variant="chrome-outline" disabled={loadingMore} onClick={() => void loadMore()}>
							{loadingMore ? <Spinner className="size-3" /> : null}
							{t("review.history.more")}
						</Button>
					</div>
				) : null}
			</CommitList>
		</div>
	);

	const commit = detail.data?.commit ?? commits.find((entry) => entry.hash === selected) ?? null;
	const refs = commit ? visibleRefs(commit.refs) : [];
	const main = !commit ? (
		<p className="px-4 py-6 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
			{loading ? t("common.loading") : t("review.history.select")}
		</p>
	) : (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-col gap-2 border-b border-[color:var(--app-surface-divider)] px-4 py-3">
				<div className="flex items-start gap-3">
					<div className="min-w-0 flex-1">
						<h3 className="break-words text-[length:var(--app-font-size-ui-lg,13px)] font-semibold leading-snug">{commit.subject}</h3>
						{detail.data?.body ? (
							<p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{detail.data.body}
							</p>
						) : null}
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<Button
							size="xs"
							variant="chrome-outline"
							onClick={() => {
								void copyText(commit.hash);
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1200);
							}}
						>
							<CopyIcon />
							{copied ? t("review.commitDetail.copied") : t("review.commitDetail.copyHash")}
						</Button>
						<Button size="xs" variant="chrome-outline" onClick={() => onBranchFrom(commit)}>
							<GitBranchIcon />
							<span className="hidden 2xl:inline">{t("review.commitDetail.branchFrom")}</span>
						</Button>
						<Button size="xs" variant="chrome-outline" title={t("review.commitDetail.revert")} onClick={() => setReverting(commit)}>
							<Undo2Icon />
							<span className="hidden 2xl:inline">{t("review.commitDetail.revert")}</span>
						</Button>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					<span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-[length:var(--app-font-size-ui-2xs,9px)] font-semibold">
						{initials(commit.author)}
					</span>
					<span className="text-foreground">{commit.author}</span>
					<span>{absoluteTime(commit.date, language)}</span>
					<span className="font-mono">{commit.shortHash}</span>
					{commit.parents.length > 1 ? <span>{t("review.commitDetail.merge")}</span> : null}
					{refs.map((ref) => (
						<span key={ref} className="rounded-full border border-[color:var(--app-surface-divider)] px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)]">
							{ref}
						</span>
					))}
				</div>
			</div>
			<CommitFilesView cwd={cwd} from={commit.parents[0] ?? null} to={commit.hash} prefs={prefs} onPrefs={onPrefs} />
		</div>
	);

	return (
		<>
			<SplitPane sidebar={sidebar} main={main} />
			<ConfirmDialog
				open={reverting !== null}
				onOpenChange={(open) => {
					if (!open) setReverting(null);
				}}
				title={t("review.commitDetail.revertTitle", { subject: reverting?.subject ?? "" })}
				description={t("review.commitDetail.revertBody", { branch: branchLabel(status, t) })}
				footer={
					<>
						<Button onClick={() => setReverting(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button autoFocus onClick={() => void revert()} size="sm">
							{t("review.commitDetail.revertAction")}
						</Button>
					</>
				}
			/>
		</>
	);
}
