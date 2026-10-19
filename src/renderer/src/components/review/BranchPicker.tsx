// FILE: BranchPicker.tsx
// Purpose: The current-branch dropdown of the review toolbar: filter, switch, create,
//          rename and delete branches.
// Layer: Review workbench

import { Popover } from "@base-ui/react/popover";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitBranch, RepoStatus } from "../../../../shared/git";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, PlusIcon, Trash2 } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME, COMPOSER_SURFACE_SHADOW_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Spinner } from "../ui/spinner";
import { relativeTime } from "./format";
import { NameDialog } from "./NameDialog";

export function branchLabel(status: RepoStatus, t: ReturnType<typeof useTranslation>["t"]): string {
	if (status.branch) return status.branch;
	if (status.detachedAt) return t("review.branch.detached", { hash: status.detachedAt });
	return "—";
}

export function BranchPicker({
	cwd,
	status,
	onChanged,
	onError,
	createFrom,
	onCreateFromHandled,
}: {
	cwd: string;
	status: RepoStatus;
	/** Called after any branch change so status, history and diffs reload. */
	onChanged: () => Promise<void>;
	onError: (message: string) => void;
	/** Set from outside (a commit's menu) to open the "new branch" dialog from that commit. */
	createFrom: { hash: string; label: string } | null;
	onCreateFromHandled: () => void;
}) {
	const { t, language } = useTranslation();
	const [open, setOpen] = useState(false);
	const [branches, setBranches] = useState<GitBranch[]>([]);
	const [loading, setLoading] = useState(false);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [localError, setLocalError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<"create" | "rename" | null>(null);
	const [creating, setCreating] = useState<{ from?: string; label: string } | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const search = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!createFrom) return;
		setCreating({ from: createFrom.hash, label: createFrom.label });
		setDialog("create");
		onCreateFromHandled();
	}, [createFrom, onCreateFromHandled]);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setLocalError(null);
		setLoading(true);
		let cancelled = false;
		api.gitBranches(cwd).then(
			(list) => {
				if (!cancelled) setBranches(list.branches);
			},
			(cause: unknown) => {
				if (!cancelled) setLocalError(errorMessage(cause));
			},
		).finally(() => {
			if (!cancelled) setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [open, cwd]);

	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const hit = (branch: GitBranch) => !needle || branch.name.toLowerCase().includes(needle);
		return {
			local: branches.filter((branch) => !branch.isRemote && hit(branch)),
			remote: branches.filter((branch) => branch.isRemote && hit(branch)),
		};
	}, [branches, query]);

	const run = async (key: string, work: () => Promise<void>, closeAfter = true) => {
		setBusy(key);
		setLocalError(null);
		try {
			await work();
			await onChanged();
			if (closeAfter) setOpen(false);
		} catch (cause) {
			const message = errorMessage(cause);
			setLocalError(message);
			if (!open) onError(message);
		} finally {
			setBusy(null);
		}
	};

	const row = (branch: GitBranch) => (
		<div
			key={`${branch.isRemote ? "r" : "l"}:${branch.name}`}
			className={cn(
				"group/branch flex h-7 items-center gap-1.5 rounded-md px-2 text-[length:var(--app-font-size-ui-sm,11px)]",
				branch.current ? "bg-[var(--sidebar-selected)]" : "hover:bg-[var(--sidebar-accent)]",
			)}
		>
			<button
				type="button"
				disabled={busy !== null || branch.current}
				onClick={() => void run(`switch:${branch.name}`, () => api.gitBranchAction({ cwd, action: "switch", name: branch.name }))}
				className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none disabled:cursor-default"
			>
				{branch.current ? <CheckIcon className="size-3 shrink-0" /> : <span className="size-3 shrink-0" />}
				<span className="min-w-0 flex-1 truncate">{branch.name}</span>
				<span className="shrink-0 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
					{relativeTime(branch.date, language)}
				</span>
			</button>
			{busy === `switch:${branch.name}` ? <Spinner className="size-3 shrink-0" /> : null}
			{!branch.isRemote && !branch.current ? (
				<button
					type="button"
					aria-label={t("review.branch.delete")}
					title={t("review.branch.delete")}
					onClick={() => setDeleting(branch.name)}
					className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover/branch:flex"
				>
					<Trash2 className="size-3" />
				</button>
			) : null}
		</div>
	);

	const section = (label: string, list: GitBranch[]) =>
		list.length === 0 ? null : (
			<div className="flex flex-col gap-px py-1">
				<div className="px-2 pb-0.5 text-[length:var(--app-font-size-ui-2xs,9px)] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
				{list.map(row)}
			</div>
		);

	return (
		<>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Trigger
					title={t("review.branch.label")}
					className="inline-flex h-7 max-w-64 min-w-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-border)] bg-transparent px-2 text-left text-[length:var(--app-font-size-ui-sm,11px)] outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:border-foreground/30 data-[popup-open]:border-foreground/30 data-[popup-open]:bg-[var(--color-background-elevated-secondary)]"
				>
					<GitBranchIcon className="size-3.5 shrink-0 opacity-80" />
					<span className="min-w-0 truncate font-medium">{branchLabel(status, t)}</span>
					<ChevronDownIcon className="size-3 shrink-0 opacity-60" />
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Positioner align="start" className="z-50" side="bottom" sideOffset={4}>
						<Popover.Popup
							data-settings-surface="popup"
							initialFocus={search}
							className={cn(
								APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
								COMPOSER_SURFACE_SHADOW_CLASS_NAME,
								"flex max-h-[min(26rem,var(--available-height,26rem))] w-72 origin-(--transform-origin) flex-col rounded-lg outline-none",
							)}
						>
							<div className="border-b border-[color:var(--color-border)] p-1.5">
								<input
									ref={search}
									value={query}
									onChange={(event) => setQuery(event.currentTarget.value)}
									placeholder={t("review.branch.filter")}
									className="font-system-ui h-7 w-full rounded-md bg-transparent px-2 text-[length:var(--app-font-size-ui-sm,11px)] outline-none placeholder:text-muted-foreground/72"
								/>
							</div>
							{localError ? (
								<p className="border-b border-[color:var(--color-border)] px-3 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{localError}</p>
							) : null}
							<div className="min-h-0 flex-1 overflow-y-auto p-1">
								{loading && branches.length === 0 ? (
									<div className="flex justify-center p-3"><Spinner className="size-3.5 text-muted-foreground" /></div>
								) : matches.local.length + matches.remote.length === 0 ? (
									<p className="px-3 py-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("review.branch.none")}</p>
								) : (
									<>
										{section(t("review.branch.local"), matches.local)}
										{section(t("review.branch.remote"), matches.remote)}
									</>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-1 border-t border-[color:var(--color-border)] p-1.5">
								<Button
									size="xs"
									variant="chrome-outline"
									className="shrink-0 whitespace-nowrap"
									onClick={() => {
										setCreating({ label: branchLabel(status, t) });
										setDialog("create");
										setOpen(false);
									}}
								>
									<PlusIcon />
									{t("review.branch.new")}
								</Button>
								{status.branch ? (
									<Button
										size="xs"
										variant="ghost"
										className="ml-auto shrink-0 whitespace-nowrap"
										onClick={() => {
											setDialog("rename");
											setOpen(false);
										}}
									>
										{t("review.branch.rename")}
									</Button>
								) : null}
							</div>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>

			<NameDialog
				open={dialog === "create"}
				title={t("review.branch.new")}
				description={creating ? t("review.branch.createFrom", { from: creating.label }) : undefined}
				placeholder={t("review.branch.namePlaceholder")}
				confirmLabel={t("review.branch.create")}
				onClose={() => setDialog(null)}
				onSubmit={async (name) => {
					await api.gitBranchAction({ cwd, action: "create", name, ...(creating?.from ? { from: creating.from } : {}) });
					setDialog(null);
					await onChanged();
				}}
			/>
			<NameDialog
				open={dialog === "rename"}
				title={t("review.branch.rename")}
				placeholder={t("review.branch.namePlaceholder")}
				initial={status.branch ?? ""}
				confirmLabel={t("review.branch.renameAction")}
				onClose={() => setDialog(null)}
				onSubmit={async (name) => {
					if (!status.branch) return;
					await api.gitBranchAction({ cwd, action: "rename", name: status.branch, newName: name });
					setDialog(null);
					await onChanged();
				}}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(next) => {
					if (!next) setDeleting(null);
				}}
				title={t("review.branch.deleteTitle", { name: deleting ?? "" })}
				description={t("review.branch.deleteBody")}
				footer={
					<>
						<Button onClick={() => setDeleting(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button
							autoFocus
							size="sm"
							variant="destructive"
							onClick={() => {
								const name = deleting;
								setDeleting(null);
								if (!name) return;
								void run(`delete:${name}`, () => api.gitBranchAction({ cwd, action: "delete", name }), false).then(() => {
									setBranches((list) => list.filter((branch) => branch.name !== name || branch.isRemote));
								});
							}}
						>
							{t("common.delete")}
						</Button>
					</>
				}
			/>
		</>
	);
}
