// FILE: CommitList.tsx
// Purpose: A list of commits — author initials, subject, who and when, branch chips, unpushed marker.
// Layer: Review workbench

import type { ReactNode } from "react";
import type { GitCommit } from "../../../../shared/git";
import { useTranslation } from "../../i18n";
import { ArrowUpIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { initials, relativeTime, visibleRefs } from "./format";

export function CommitRow({
	commit,
	selected,
	onSelect,
}: {
	commit: GitCommit;
	selected: boolean;
	onSelect: () => void;
}) {
	const { t, language } = useTranslation();
	const refs = visibleRefs(commit.refs).slice(0, 2);
	return (
		<div
			role="option"
			aria-selected={selected}
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect();
				}
			}}
			title={`${commit.shortHash} · ${commit.author}`}
			className={cn(
				"flex shrink-0 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 outline-none transition-colors",
				"focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]/60",
				selected ? "bg-[var(--sidebar-selected)]" : "hover:bg-[var(--sidebar-accent)]",
			)}
		>
			<span
				aria-hidden="true"
				className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-[length:var(--app-font-size-ui-2xs,9px)] font-semibold text-muted-foreground"
			>
				{initials(commit.author)}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-1.5">
					<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)] font-medium">{commit.subject}</span>
					{commit.unpushed ? (
						<ArrowUpIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t("review.history.unpushed")}>
							<title>{t("review.history.unpushed")}</title>
						</ArrowUpIcon>
					) : null}
				</div>
				<div className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					<span className="min-w-0 truncate">{commit.author}</span>
					<span className="shrink-0">·</span>
					<span className="shrink-0">{relativeTime(commit.date, language)}</span>
					<span className="flex-1" />
					{refs.map((ref) => (
						<span
							key={ref}
							className="max-w-24 shrink truncate rounded-full border border-[color:var(--app-surface-divider)] px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)]"
						>
							{ref}
						</span>
					))}
					<span className="shrink-0 font-mono">{commit.shortHash}</span>
				</div>
			</div>
		</div>
	);
}

export function CommitList({ children }: { children: ReactNode }) {
	return (
		<div role="listbox" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
			{children}
		</div>
	);
}
