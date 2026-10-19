// FILE: SyncButton.tsx
// Purpose: The one toolbar button that does the next sensible thing with the remote:
//          publish a new branch, pull what is new, push what is local, or fetch.
// Layer: Review workbench

import type { RepoStatus, GitRemoteActionKind } from "../../../../shared/git";
import { useTranslation } from "../../i18n";
import { ArrowDownIcon, ArrowUpIcon, PushIcon, RefreshCwIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Spinner } from "../ui/spinner";

export type SyncPlan = { action: GitRemoteActionKind; publish: boolean };

/** What the main button should do for this repository state. */
export function planSync(status: Pick<RepoStatus, "remote" | "upstream" | "ahead" | "behind" | "hasCommits">): SyncPlan | null {
	if (!status.remote) return null;
	if (!status.upstream) return status.hasCommits ? { action: "push", publish: true } : null;
	if ((status.behind ?? 0) > 0) return { action: "pull", publish: false };
	if ((status.ahead ?? 0) > 0) return { action: "push", publish: false };
	return { action: "fetch", publish: false };
}

export function SyncButton({
	status,
	busy,
	onRun,
}: {
	status: RepoStatus;
	busy: GitRemoteActionKind | null;
	onRun: (action: GitRemoteActionKind) => void;
}) {
	const { t } = useTranslation();
	const plan = planSync(status);
	const remote = status.remote ?? "origin";
	const upstream = status.upstream ?? remote;
	const ahead = status.ahead ?? 0;
	const behind = status.behind ?? 0;

	if (!status.remote) {
		return (
			<span className="px-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground" title={t("review.sync.noRemoteHint")}>
				{t("review.sync.noRemote")}
			</span>
		);
	}
	if (!plan) return null;

	const label = plan.publish
		? t("review.sync.publish")
		: plan.action === "pull"
			? t("review.sync.pull", { remote })
			: plan.action === "push"
				? t("review.sync.push", { remote })
				: t("review.sync.fetch", { remote });
	const tip = plan.publish
		? t("review.sync.publishTip", { remote })
		: plan.action === "pull"
			? t("review.sync.pullTip", { count: behind, upstream })
			: plan.action === "push"
				? t("review.sync.pushTip", { count: ahead, upstream })
				: t("review.sync.fetchTip", { remote });
	const working = busy !== null;
	const icon = working ? (
		<Spinner className="size-3.5" />
	) : plan.publish ? (
		<PushIcon />
	) : plan.action === "pull" ? (
		<ArrowDownIcon />
	) : plan.action === "push" ? (
		<ArrowUpIcon />
	) : (
		<RefreshCwIcon />
	);

	return (
		<div className="flex items-center gap-1">
			<Button
				size="xs"
				variant={plan.action === "fetch" ? "chrome-outline" : "subtle"}
				disabled={working}
				aria-busy={working}
				title={tip}
				onClick={() => onRun(plan.action)}
			>
				{icon}
				<span>{busy ? t(`review.sync.${busy}Working`, { remote }) : label}</span>
				{!plan.publish && (ahead > 0 || behind > 0) ? (
					<span className="tabular-nums text-muted-foreground">
						{behind > 0 ? `↓${String(behind)}` : ""}
						{behind > 0 && ahead > 0 ? " " : ""}
						{ahead > 0 ? `↑${String(ahead)}` : ""}
					</span>
				) : null}
			</Button>
			{plan.action !== "fetch" && !plan.publish ? (
				<IconButton label={t("review.sync.fetch", { remote })} tooltip={t("review.sync.fetchTip", { remote })} disabled={working} onClick={() => onRun("fetch")}>
					{busy === "fetch" ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
				</IconButton>
			) : null}
		</div>
	);
}
