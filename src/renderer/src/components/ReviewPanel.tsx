import { useCallback, useEffect, useState } from "react";
import type { RepoStatus, ReviewScope } from "../../../shared/git";
import { api, errorMessage } from "../api";
import { useTranslation, type TranslationKey } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { DiffStat } from "./ui/diff-stat";
import { Spinner } from "./ui/spinner";
import { XIcon } from "../lib/icons";

const SCOPES: { id: ReviewScope; labelKey: TranslationKey }[] = [
	{ id: "unstaged", labelKey: "review.scope.unstaged" },
	{ id: "staged", labelKey: "review.scope.staged" },
	{ id: "branch", labelKey: "review.scope.branch" },
];

/** Minimal unified-diff renderer: colors +/- lines without a diff library. */
function DiffView({ patch }: { patch: string }) {
	const { t } = useTranslation();
	if (!patch.trim()) {
		return (
			<p className="px-3 py-4 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{t("review.noChanges")}
			</p>
		);
	}
	const lines = patch.split("\n");
	return (
		<pre className="overflow-auto p-3 font-mono text-[length:var(--app-font-size-chat-code,11px)] leading-5">
			{lines.map((line, index) => {
				const key = `${String(index)}:${line.slice(0, 24)}`;
				const isAdd = line.startsWith("+") && !line.startsWith("+++");
				const isRemove = line.startsWith("-") && !line.startsWith("---");
				const isMeta = line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ");
				return (
					<div
						key={key}
						className={cn(
							"whitespace-pre",
							isAdd && "bg-[color-mix(in_srgb,var(--success)_16%,transparent)]",
							isRemove && "bg-[color-mix(in_srgb,var(--destructive)_16%,transparent)]",
							isMeta && "text-muted-foreground",
						)}
					>
						{line || " "}
					</div>
				);
			})}
		</pre>
	);
}

export function ReviewPanel({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<RepoStatus | null>(null);
	const [scope, setScope] = useState<ReviewScope>("unstaged");
	const [files, setFiles] = useState<string[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [patch, setPatch] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!cwd) return;
		setLoading(true);
		try {
			// Status first: when git itself is missing, every other git call would
			// throw too, and the panel needs the status to explain why.
			const nextStatus = await api.gitStatus(cwd);
			setStatus(nextStatus);
			if (!nextStatus.gitAvailable || !nextStatus.isRepo) {
				setFiles([]);
				setPatch("");
				setSelected(null);
				setError(null);
				return;
			}
			const nextFiles = await api.gitFiles(cwd, scope);
			setFiles(nextFiles);
			setError(null);
			setSelected((current) => (current && nextFiles.includes(current) ? current : (nextFiles[0] ?? null)));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [cwd, scope]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!cwd || !selected || status?.gitAvailable === false) {
			setPatch("");
			return;
		}
		let cancelled = false;
		api
			.gitDiff({ cwd, scope, file: selected })
			.then((next) => {
				if (!cancelled) setPatch(next);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, scope, selected, status?.gitAvailable]);

	const act = async (action: "stage" | "unstage" | "revert", file?: string) => {
		if (!cwd) return;
		try {
			await api.gitAction({ cwd, action, ...(file === undefined ? {} : { file }) });
			await refresh();
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("review.title")}</span>
				{status?.branch ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
						{status.branch}
					</span>
				) : null}
				<div className="ml-2 flex items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5">
					{SCOPES.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setScope(entry.id)}
							className={cn(
								"rounded-sm px-2 py-0.5 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								scope === entry.id
									? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)]"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{t(entry.labelKey)}
						</button>
					))}
				</div>
				{loading ? <Spinner className="size-3 text-muted-foreground" /> : null}
				<div className="flex-1" />
				<Button onClick={() => void refresh()} size="xs" variant="chrome-outline">
					{t("common.refresh")}
				</Button>
				<Button onClick={onClose} size="icon-xs" variant="ghost">
					<XIcon className="size-3.5" />
				</Button>
			</header>

			{error ? (
				<div className="border-b border-[color:var(--app-surface-divider)] px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</div>
			) : null}

			{!cwd ? (
				<p className="p-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("review.openProject")}
				</p>
			) : status && !status.gitAvailable ? (
				<div className="flex flex-col items-start gap-2 p-3">
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
						{status.gitError ?? t("review.gitUnavailable")}
					</p>
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("review.gitUnavailableHint")}
					</p>
				</div>
			) : status && !status.isRepo ? (
				<div className="flex flex-col items-start gap-2 p-3">
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("review.notRepo")}
					</p>
					<Button
						onClick={() => void api.gitInit(cwd).then(refresh)}
						size="sm"
						variant="subtle"
					>
						{t("review.initRepo")}
					</Button>
				</div>
			) : (
				<div className="flex min-h-0 flex-1">
					<div className="flex w-64 min-w-0 shrink-0 flex-col overflow-y-auto border-r border-[color:var(--app-surface-divider)] p-1.5">
						{files.length === 0 ? (
							<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{t("review.noFiles")}
							</p>
						) : (
							files.map((file) => {
								const entry = status?.files.find((candidate) => candidate.path === file);
								return (
									<button
										key={file}
										type="button"
										onClick={() => setSelected(file)}
										className={cn(
											"flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
											selected === file
												? "bg-[var(--sidebar-selected)] text-foreground"
												: "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground",
										)}
									>
										<span className="min-w-0 flex-1 truncate">{file}</span>
										{entry ? (
											<DiffStat
												className="shrink-0 text-[length:var(--app-font-size-ui-2xs,9px)]"
												deletions={entry.deletions}
												insertions={entry.additions}
											/>
										) : null}
									</button>
								);
							})
						)}
					</div>

					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						{selected ? (
							<div className="flex h-9 shrink-0 items-center gap-1 border-b border-[color:var(--app-surface-divider)] px-2">
								<span className="min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
									{selected}
								</span>
								{scope === "staged" ? (
									<Button
										onClick={() => void act("unstage", selected)}
										size="xs"
										variant="chrome-outline"
									>
										{t("review.unstage")}
									</Button>
								) : scope === "unstaged" ? (
									<Button
										onClick={() => void act("stage", selected)}
										size="xs"
										variant="chrome-outline"
									>
										{t("review.stage")}
									</Button>
								) : null}
								{scope !== "branch" ? (
									<Button
										onClick={() => void act("revert", selected)}
										size="xs"
										variant="destructive-outline"
									>
										{t("review.revert")}
									</Button>
								) : null}
							</div>
						) : null}
						<div className="min-h-0 flex-1 overflow-auto">
							<DiffView patch={patch} />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
