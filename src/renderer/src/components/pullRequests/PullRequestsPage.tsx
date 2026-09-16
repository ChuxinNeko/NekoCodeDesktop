import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
	PullRequestDetail,
	PullRequestFilter,
	PullRequestSummary,
	RepositoryIdentity,
} from "../../../../shared/pullRequests";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import {
	CircleCheckIcon,
	CircleAlertIcon,
	ExternalLinkIcon,
	GitPullRequestDraftIcon,
	GitPullRequestClosedIcon,
	GitMergeIcon,
	GitPullRequestIcon,
	Loader2Icon,
	PlusIcon,
	RefreshCwIcon,
	XIcon,
} from "../../lib/icons";

const FILTERS: { id: PullRequestFilter; labelKey: TranslationKey }[] = [
	{ id: "open", labelKey: "pr.filter.open" },
	{ id: "closed", labelKey: "pr.filter.closed" },
	{ id: "all", labelKey: "pr.filter.all" },
];

function relativeTime(iso: string): string {
	const timestamp = Date.parse(iso);
	if (Number.isNaN(timestamp)) return "";
	const minutes = Math.round((Date.now() - timestamp) / 60_000);
	if (minutes < 60) return `${String(Math.max(1, minutes))}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${String(hours)}h`;
	return `${String(Math.round(hours / 24))}d`;
}

function StateGlyph({ pull }: { pull: Pick<PullRequestSummary, "state"> }) {
	switch (pull.state) {
		case "merged":
			return <GitMergeIcon className="size-3.5 shrink-0 text-[var(--color-status-merged)]" />;
		case "closed":
			return <GitPullRequestClosedIcon className="size-3.5 shrink-0 text-destructive" />;
		case "draft":
			return <GitPullRequestDraftIcon className={cn("size-3.5 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} />;
		default:
			return <GitPullRequestIcon className="size-3.5 shrink-0 text-[var(--success)]" />;
	}
}

function ChecksGlyph({ pull }: { pull: PullRequestSummary }) {
	const { checks } = pull;
	if (checks.total === 0) return null;
	if (checks.failure > 0) {
		return (
			<span className="inline-flex items-center gap-0.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-destructive">
				<CircleAlertIcon className="size-3" />
				{checks.failure}
			</span>
		);
	}
	if (checks.pending > 0) {
		return <Loader2Icon className="size-3 animate-spin text-muted-foreground" />;
	}
	return <CircleCheckIcon className="size-3 text-[var(--success)]" />;
}

function PullRequestRow({
	pull,
	selected,
	onSelect,
}: {
	pull: PullRequestSummary;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors",
				selected
					? "bg-[var(--sidebar-selected)] text-foreground"
					: "hover:bg-[var(--sidebar-accent)]",
			)}
		>
			<div className="flex items-center gap-1.5">
				<StateGlyph pull={pull} />
				<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)]">
					{pull.title}
				</span>
				<ChecksGlyph pull={pull} />
				<span className={cn("shrink-0 text-[length:var(--app-font-size-ui-timestamp,8px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					{relativeTime(pull.updatedAt)}
				</span>
			</div>
			<div className={cn("flex items-center gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
				<span className="shrink-0">#{pull.number}</span>
				<span className="min-w-0 truncate">{pull.author}</span>
				<span className="shrink-0">
					{pull.headRef} → {pull.baseRef}
				</span>
			</div>
		</button>
	);
}

function CommentCard({
	author,
	avatarUrl,
	body,
	createdAt,
	anchor,
}: {
	author: string;
	avatarUrl?: string;
	body: string;
	createdAt: string;
	anchor?: string;
}) {
	return (
		<div className="flex gap-2 rounded-lg border border-border p-2.5">
			{avatarUrl ? (
				<img alt="" className="size-5 shrink-0 rounded-full" src={avatarUrl} />
			) : (
				<span className="size-5 shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)]" />
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex items-center gap-1.5">
					<span className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium">{author}</span>
					<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						{relativeTime(createdAt)}
					</span>
					{anchor ? (
						<span className="truncate font-mono text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
							{anchor}
						</span>
					) : null}
				</div>
				<div className="chat-markdown">
					<ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
				</div>
			</div>
		</div>
	);
}

function CreatePullRequestForm({
	cwd,
	onCreated,
	onCancel,
}: {
	cwd: string;
	onCreated: (pull: PullRequestSummary) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [base, setBase] = useState("main");
	const [head, setHead] = useState("");
	const [draft, setDraft] = useState(false);
	const [branches, setBranches] = useState<{ name: string; isCurrent: boolean }[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void api.prBranches(cwd).then((list) => {
			if (cancelled) return;
			setBranches(list);
			const current = list.find((branch) => branch.isCurrent);
			if (current) setHead(current.name);
		});
		return () => {
			cancelled = true;
		};
	}, [cwd]);

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const created = await api.prCreate({ cwd, title, body, base, head, draft });
			onCreated(created);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border p-3">
			<div className="flex flex-col gap-1">
				<Label>{t("pr.form.title")}</Label>
				<Input value={title} onChange={(event) => setTitle(event.target.value)} />
			</div>
			<div className="flex flex-col gap-1">
				<Label>{t("pr.form.body")}</Label>
				<Textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} />
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1">
					<Label>{t("pr.form.head")}</Label>
					<select
						className="h-8 rounded-lg border border-border bg-transparent px-2 text-[length:var(--app-font-size-ui,12px)]"
						onChange={(event) => setHead(event.target.value)}
						value={head}
					>
						<option value="">{t("common.select")}</option>
						{branches.map((branch) => (
							<option key={branch.name} value={branch.name}>
								{branch.name}
							</option>
						))}
					</select>
				</div>
				<div className="flex flex-col gap-1">
					<Label>{t("pr.form.base")}</Label>
					<Input value={base} onChange={(event) => setBase(event.target.value)} />
				</div>
			</div>
			<label className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]">
				<input checked={draft} onChange={(event) => setDraft(event.target.checked)} type="checkbox" />
				{t("pr.form.draft")}
			</label>
			{error ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p>
			) : null}
			<div className="flex items-center gap-2">
				<div className="flex-1" />
				<Button onClick={onCancel} size="sm" variant="ghost">
					{t("common.cancel")}
				</Button>
				<Button
					disabled={busy || title.trim().length === 0 || head.length === 0}
					onClick={() => void submit()}
					size="sm"
					variant="subtle"
				>
					{busy ? <Spinner className="size-3" /> : null}
					{t("pr.form.submit")}
				</Button>
			</div>
		</div>
	);
}

export function PullRequestsPage({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
	const { t } = useTranslation();
	const [filter, setFilter] = useState<PullRequestFilter>("open");
	const [repository, setRepository] = useState<RepositoryIdentity | null>(null);
	const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
	const [selected, setSelected] = useState<number | null>(null);
	const [detail, setDetail] = useState<PullRequestDetail | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const refresh = useCallback(async () => {
		if (!cwd) return;
		setLoading(true);
		try {
			const result = await api.prList(cwd, filter);
			setRepository(result.repository);
			setPullRequests(result.pullRequests);
			setError(null);
			setSelected((current) =>
				current !== null && result.pullRequests.some((pull) => pull.number === current)
					? current
					: (result.pullRequests[0]?.number ?? null),
			);
		} catch (cause) {
			setPullRequests([]);
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [cwd, filter]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!cwd || selected === null) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		setDetail(null);
		api
			.prDetail(cwd, selected)
			.then((next) => {
				if (!cancelled) setDetail(next);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, selected]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<GitPullRequestIcon className="size-3.5" />
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("nav.pullRequests")}</span>
				{repository ? (
					<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						{repository.owner}/{repository.repo}
					</span>
				) : null}
				<div className="ml-2 flex items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5">
					{FILTERS.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setFilter(entry.id)}
							className={cn(
								"rounded-sm px-2 py-0.5 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								filter === entry.id
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
				<Button
					disabled={!cwd}
					onClick={() => setCreating((open) => !open)}
					size="xs"
					variant="chrome-outline"
				>
					<PlusIcon className="size-3.5" />
					{t("common.new")}
				</Button>
				<Button onClick={() => void refresh()} size="icon-xs" variant="ghost">
					<RefreshCwIcon className="size-3.5" />
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
					{t("pr.openProject")}
				</p>
			) : !repository && !loading ? (
				<p className="p-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("pr.noRemote")}
				</p>
			) : (
				<div className="flex min-h-0 flex-1">
					<div className="flex w-80 min-w-0 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[color:var(--app-surface-divider)] p-1.5">
						{creating && cwd ? (
							<CreatePullRequestForm
								cwd={cwd}
								onCancel={() => setCreating(false)}
								onCreated={(created) => {
									setCreating(false);
									setSelected(created.number);
									void refresh();
								}}
							/>
						) : null}
						{pullRequests.length === 0 && !loading ? (
							<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{t("pr.empty")}
							</p>
						) : (
							pullRequests.map((pull) => (
								<PullRequestRow
									key={pull.number}
									onSelect={() => setSelected(pull.number)}
									pull={pull}
									selected={pull.number === selected}
								/>
							))
						)}
					</div>

					<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4">
						{detail === null ? (
							<div className="flex flex-1 items-center justify-center">
								{selected === null ? (
									<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
										{t("pr.select")}
									</p>
								) : (
									<Spinner className="size-4 text-muted-foreground" />
								)}
							</div>
						) : (
							<div className="flex flex-col gap-4">
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-2">
										<StateGlyph pull={detail} />
										<h2 className="min-w-0 flex-1 text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
											{detail.title}
										</h2>
										<Button
											onClick={() => void api.openExternal(detail.url)}
											size="xs"
											variant="chrome-outline"
										>
											<ExternalLinkIcon className="size-3.5" />
											{t("common.open")}
										</Button>
									</div>
									<p className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
										#{detail.number} · {detail.author} · {detail.headRef} → {detail.baseRef} ·{" "}
										{relativeTime(detail.createdAt)}
									</p>
								</div>

								{detail.body.trim().length > 0 ? (
									<div className="chat-markdown">
										<ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.body}</ReactMarkdown>
									</div>
								) : null}

								{detail.checkRuns.length > 0 ? (
									<div className="flex flex-col gap-1">
										<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
											{t("pr.checks", {
												success: detail.checks.success,
												total: detail.checks.total,
											})}
										</span>
										{detail.checkRuns.map((run) => (
											<div
												key={`${run.name}:${run.state}`}
												className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)]"
											>
												{run.state === "success" ? (
													<CircleCheckIcon className="size-3 text-[var(--success)]" />
												) : run.state === "failure" ? (
													<CircleAlertIcon className="size-3 text-destructive" />
												) : (
													<Loader2Icon className="size-3 text-muted-foreground" />
												)}
												<span className="min-w-0 truncate">{run.name}</span>
											</div>
										))}
									</div>
								) : null}

								{detail.reviewComments.length > 0 ? (
									<div className="flex flex-col gap-2">
										<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
											{t("pr.reviewComments")}
										</span>
										{detail.reviewComments.map((comment) => (
											<CommentCard
												key={comment.id}
												anchor={
													comment.path
														? `${comment.path}${comment.line === undefined ? "" : `:${String(comment.line)}`}`
														: undefined
												}
												author={comment.author}
												body={comment.body}
												createdAt={comment.createdAt}
												{...(comment.authorAvatarUrl ? { avatarUrl: comment.authorAvatarUrl } : {})}
											/>
										))}
									</div>
								) : null}

								{detail.issueComments.length > 0 ? (
									<div className="flex flex-col gap-2">
										<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
											{t("pr.comments")}
										</span>
										{detail.issueComments.map((comment) => (
											<CommentCard
												key={comment.id}
												author={comment.author}
												body={comment.body}
												createdAt={comment.createdAt}
												{...(comment.authorAvatarUrl ? { avatarUrl: comment.authorAvatarUrl } : {})}
											/>
										))}
									</div>
								) : null}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
