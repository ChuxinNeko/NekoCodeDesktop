// FILE: CommitFilesView.tsx
// Purpose: The files a revision range changed, with the selected file's diff beside
//          them — the detail pane for a commit in History and for Compare.
// Layer: Review workbench

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { DiffViewer } from "./DiffViewer";
import { FileRow } from "./FileRow";
import { changeLetter } from "./format";
import { useAsync, type DiffPrefs } from "./hooks";
import { SplitPane } from "./SplitPane";

export function CommitFilesView({
	cwd,
	from,
	to,
	prefs,
	onPrefs,
	emptyText,
}: {
	cwd: string;
	/** null diffs against the empty tree, which is how a root commit is shown. */
	from: string | null;
	to: string;
	prefs: DiffPrefs;
	onPrefs: (next: DiffPrefs) => void;
	emptyText?: ReactNode;
}) {
	const { t } = useTranslation();
	const files = useAsync(() => api.gitRangeFiles({ cwd, from, to }), [cwd, from, to], `${from ?? ""}..${to}`);
	const list = files.data ?? [];
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		setSelected((current) => (current && list.some((file) => file.path === current) ? current : (list[0]?.path ?? null)));
	}, [files.data]); // eslint-disable-line react-hooks/exhaustive-deps -- `list` is derived from files.data

	const current = list.find((file) => file.path === selected) ?? null;
	const diff = useAsync(
		current
			? () => api.gitRangeDiff({ cwd, from, to, file: current.path, ...(current.oldPath ? { oldPath: current.oldPath } : {}), ignoreWhitespace: prefs.ignoreWhitespace })
			: null,
		[cwd, from, to, current?.path, current?.oldPath, prefs.ignoreWhitespace],
		`${from ?? ""}..${to}:${current?.path ?? ""}`,
	);

	if (!files.loading && list.length === 0) {
		return (
			<p className="px-4 py-6 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{files.error ?? emptyText ?? t("review.commitDetail.noFiles")}
			</p>
		);
	}

	return (
		<SplitPane
			storageKey="nekocode:review:files"
			defaultWidth={250}
			compactBelow={760}
			compactHeight="h-[38%]"
			sidebar={
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="shrink-0 px-3 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{list.length === 1 ? t("review.files.one") : t("review.files.many", { count: list.length })}
					</div>
					<div role="listbox" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-1.5">
						{list.map((file) => (
							<FileRow
								key={file.path}
								path={file.path}
								{...(file.oldPath ? { oldPath: file.oldPath } : {})}
								letter={changeLetter(file)}
								additions={file.additions}
								deletions={file.deletions}
								selected={file.path === selected}
								onSelect={() => setSelected(file.path)}
							/>
						))}
					</div>
				</div>
			}
			main={
				<DiffViewer
					patch={diff.error ? "" : (diff.data ?? "")}
					loading={files.loading || diff.loading}
					path={current?.path ?? null}
					prefs={prefs}
					onPrefs={onPrefs}
				/>
			}
		/>
	);
}
