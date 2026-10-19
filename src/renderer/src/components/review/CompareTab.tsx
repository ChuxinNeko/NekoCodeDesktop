// FILE: CompareTab.tsx
// Purpose: The Compare tab: how the current branch differs from its base — every file
//          the branch changes, or the files of any one commit on it.
// Layer: Review workbench

import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";
import { branchLabel } from "./BranchPicker";
import { CommitFilesView } from "./CommitFilesView";
import { CommitList, CommitRow } from "./CommitList";
import { useAsync } from "./hooks";
import { SplitPane } from "./SplitPane";
import type { TabProps } from "./types";

export function CompareTab({ cwd, status, prefs, onPrefs, tabs, onError }: TabProps) {
	const { t } = useTranslation();
	const headKey = `${status.branch ?? ""}:${status.lastCommit?.hash ?? ""}`;
	const info = useAsync(() => api.gitCompareInfo(cwd), [cwd, headKey], cwd);
	const base = info.data?.base ?? null;
	const mergeBase = info.data?.mergeBase ?? null;
	const log = useAsync(
		base ? () => api.gitLog({ cwd, limit: 300, ...(mergeBase ? { since: mergeBase } : {}) }) : null,
		[cwd, headKey, base, mergeBase],
		`${cwd}:${base ?? ""}`,
	);
	const [selected, setSelected] = useState<"all" | string>("all");
	useEffect(() => setSelected("all"), [cwd, headKey]);
	useEffect(() => {
		if (info.error) onError(info.error);
	}, [info.error]); // eslint-disable-line react-hooks/exhaustive-deps -- report once per failure

	const commits = log.data?.commits ?? [];
	const commit = selected === "all" ? null : (commits.find((entry) => entry.hash === selected) ?? null);
	const branch = branchLabel(status, t);

	const sidebar = (
		<div className="flex min-h-0 flex-1 flex-col">
			{tabs}
			{base ? (
				<div className="flex shrink-0 flex-col gap-1 border-b border-[color:var(--app-surface-divider)] px-3 py-2">
					<div className="break-words text-[length:var(--app-font-size-ui-sm,11px)] font-medium">
						{t("review.compare.title", { branch, base })}
					</div>
					<div className="flex gap-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						<span>{t("review.compare.ahead", { count: info.data?.ahead ?? 0 })}</span>
						<span>·</span>
						<span>{t("review.compare.behind", { count: info.data?.behind ?? 0 })}</span>
					</div>
				</div>
			) : null}
			<CommitList>
				{info.loading && !info.data ? (
					<div className="flex justify-center p-4"><Spinner className="size-4 text-muted-foreground" /></div>
				) : !base ? (
					<p className="px-2 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.compare.noBase")}</p>
				) : (
					<>
						<div
							role="option"
							aria-selected={selected === "all"}
							tabIndex={0}
							onClick={() => setSelected("all")}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									setSelected("all");
								}
							}}
							className={cn(
								"flex h-8 shrink-0 cursor-pointer items-center rounded-md px-2 text-[length:var(--app-font-size-ui-sm,11px)] font-medium outline-none transition-colors",
								selected === "all" ? "bg-[var(--sidebar-selected)]" : "hover:bg-[var(--sidebar-accent)]",
							)}
						>
							{t("review.compare.all")}
						</div>
						{commits.map((entry) => (
							<CommitRow key={entry.hash} commit={entry} selected={entry.hash === selected} onSelect={() => setSelected(entry.hash)} />
						))}
					</>
				)}
			</CommitList>
		</div>
	);

	const main = !base ? (
		<p className="px-4 py-6 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
			{info.loading ? t("common.loading") : t("review.compare.noBase")}
		</p>
	) : (
		<CommitFilesView
			cwd={cwd}
			from={commit ? (commit.parents[0] ?? null) : mergeBase}
			to={commit ? commit.hash : "HEAD"}
			prefs={prefs}
			onPrefs={onPrefs}
			emptyText={t("review.compare.same", { branch, base })}
		/>
	);

	return <SplitPane sidebar={sidebar} main={main} />;
}
