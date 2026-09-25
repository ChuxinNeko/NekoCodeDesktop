import { useEffect, useState } from "react";
import { formatGoalElapsed, goalElapsedMs, type GoalAction, type GoalState } from "../../../../shared/goal";
import { formatCompactTokens } from "../../../../shared/tokenStats";
import { formatCost } from "../../../../shared/usage";
import { errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { GoalIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { CHAT_COLUMN_FRAME_CLASS_NAME, CHAT_COLUMN_GUTTER_CLASS_NAME } from "./composerPickerStyles";

const STATUS_KEY: Record<GoalState["status"], TranslationKey> = {
	active: "goal.status.active",
	paused: "goal.status.paused",
	completed: "goal.status.completed",
	blocked: "goal.status.blocked",
};

const STATUS_DOT: Record<GoalState["status"], string> = {
	active: "bg-[var(--success,#16a34a)] animate-pulse",
	paused: "bg-muted-foreground/50",
	completed: "bg-[var(--success,#16a34a)]",
	blocked: "bg-[var(--warning,#d97706)]",
};

/**
 * The session's `/goal`, above the composer: what the agent is working
 * towards, how far the automatic loop has run, and the controls to stop it.
 *
 * Always on screen while a goal exists, because a loop that keeps spending
 * turns on its own has to be visibly running — and stoppable from where the
 * user is looking.
 */
export function GoalBanner({ goal, onAction }: { goal: GoalState; onAction: (action: GoalAction) => Promise<unknown> }) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [expanded, setExpanded] = useState(false);
	// The clock only moves while the goal does; a paused one shows a fixed time
	// and costs no re-renders.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (goal.status !== "active") return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [goal.status]);

	const act = (action: GoalAction) => {
		setBusy(true);
		setError("");
		onAction(action)
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const finished = goal.status === "completed";

	return (
		<div className={cn("shrink-0 pb-1", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
			<div
				className={cn(
					CHAT_COLUMN_FRAME_CLASS_NAME,
					"flex flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[length:var(--app-font-size-ui,12px)]",
				)}
			>
				<div className="flex items-center gap-2">
					<GoalIcon className="size-3.5 shrink-0 opacity-70" />
					<span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[goal.status])} />
					<button
						type="button"
						onClick={() => setExpanded((open) => !open)}
						className={cn(
							"min-w-0 flex-1 text-left",
							expanded ? "max-h-32 overflow-y-auto whitespace-pre-wrap break-words" : "truncate",
						)}
						title={goal.objective}
					>
						{goal.objective}
					</button>
					<span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t(STATUS_KEY[goal.status])}
					</span>
					{goal.status === "active" ? (
						<Button disabled={busy} onClick={() => act({ type: "pause" })} size="xs" variant="chrome-outline">
							{t("goal.pause")}
						</Button>
					) : !finished ? (
						<Button disabled={busy} onClick={() => act({ type: "resume" })} size="xs" variant="chrome-outline">
							{t("goal.resume")}
						</Button>
					) : null}
					<Button disabled={busy} onClick={() => act({ type: "clear" })} size="xs" variant="ghost">
						{t(finished ? "goal.dismiss" : "goal.stop")}
					</Button>
				</div>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[1.375rem] font-mono text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground">
					<span title={t("goal.elapsedHint")}>
						{t("goal.elapsed")} {formatGoalElapsed(goalElapsedMs(goal, now))}
					</span>
					<span>{t("goal.turns", { turns: goal.turns, max: goal.maxTurns })}</span>
					<span title={t("goal.spendHint")}>
						{formatCompactTokens(goal.usage.tokens)} tokens
						{goal.usage.cost > 0 ? ` · ${formatCost(goal.usage.cost)}` : ""}
					</span>
				</div>
				{/* The closing summary can run to pages; it scrolls in place so the
				    transcript and composer keep their room. */}
				{goal.reason ? (
					<p
						className={cn(
							"max-h-[min(12rem,30vh)] overflow-y-auto whitespace-pre-wrap break-words pl-[1.375rem] text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed",
							goal.status === "blocked" ? "text-[var(--warning,#d97706)]" : "text-muted-foreground",
						)}
					>
						<span className="font-medium">{t("goal.reason")}</span>
						{goal.reason}
					</p>
				) : null}
				{goal.status === "blocked" ? (
					<p className="pl-[1.375rem] text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t("goal.blockedHint")}
					</p>
				) : null}
				{error ? <p className="pl-[1.375rem] text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</p> : null}
			</div>
		</div>
	);
}
