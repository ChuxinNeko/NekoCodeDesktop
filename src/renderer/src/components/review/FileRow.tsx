// FILE: FileRow.tsx
// Purpose: One changed file in a list: optional checkbox, status letter, name, folder and size.
// Layer: Review workbench

import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { DiffStat } from "../ui/diff-stat";
import { GIT_STATUS_CLASS, type GitLetter } from "../ide/git-decorations";
import { splitPath } from "./format";

export function FileRow({
	path,
	oldPath,
	letter,
	additions,
	deletions,
	selected,
	onSelect,
	onContextMenu,
	checked,
	onCheckedChange,
	checkDisabled,
	trailing,
}: {
	path: string;
	oldPath?: string;
	letter: GitLetter;
	additions: number;
	deletions: number;
	selected: boolean;
	onSelect: () => void;
	onContextMenu?: (event: MouseEvent) => void;
	/** Omit `checked` for a read-only list such as a commit's files. */
	checked?: boolean;
	onCheckedChange?: (next: boolean) => void;
	checkDisabled?: boolean;
	trailing?: ReactNode;
}) {
	const { t } = useTranslation();
	const { dir, name } = splitPath(path);
	const label = t(`review.status.${letter}` as const);
	return (
		<div
			role="option"
			aria-selected={selected}
			tabIndex={0}
			title={oldPath ? `${oldPath} → ${path}` : path}
			onClick={onSelect}
			onContextMenu={onContextMenu}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect();
				}
			}}
			className={cn(
				"flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[length:var(--app-font-size-ui-sm,11px)] outline-none transition-colors",
				"focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]/60",
				selected ? "bg-[var(--sidebar-selected)] text-foreground" : "text-foreground/90 hover:bg-[var(--sidebar-accent)]",
			)}
		>
			{checked === undefined ? null : (
				<span onClick={(event) => event.stopPropagation()} className="flex shrink-0">
					<Checkbox
						aria-label={name}
						checked={checked}
						disabled={checkDisabled}
						onCheckedChange={(next) => onCheckedChange?.(next === true)}
					/>
				</span>
			)}
			<FileTypeIcon name={name} className="size-3.5 shrink-0" />
			<span className={cn("min-w-0 shrink truncate", letter === "D" && "text-muted-foreground line-through")}>{name}</span>
			{dir ? (
				<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{dir}</span>
			) : (
				<span className="flex-1" />
			)}
			{additions + deletions > 0 ? (
				<DiffStat className="shrink-0 text-[length:var(--app-font-size-ui-2xs,9px)]" insertions={additions} deletions={deletions} />
			) : null}
			{trailing}
			<span
				title={label}
				aria-label={label}
				className={cn("w-3 shrink-0 text-center text-[length:var(--app-font-size-ui-xs,10px)] font-semibold", GIT_STATUS_CLASS[letter])}
			>
				{letter}
			</span>
		</div>
	);
}
