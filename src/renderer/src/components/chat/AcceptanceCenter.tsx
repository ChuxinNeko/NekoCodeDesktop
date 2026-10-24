import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { acceptanceMarkdown, type AcceptanceCheck, type AcceptanceReport, type AcceptanceStatus } from "../../../../shared/acceptance";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { XIcon } from "../../lib/icons";
import { Button } from "../ui/button";

const STATUS_KEYS: Record<AcceptanceStatus, TranslationKey> = {
	pending: "acceptance.pending", running: "acceptance.running", passed: "acceptance.passed", failed: "acceptance.failed",
	skipped: "acceptance.skipped", unverified: "acceptance.unverified", stale: "acceptance.stale",
};

export function AcceptanceStatusBadge({ status }: { status: AcceptanceStatus }) {
	const { t } = useTranslation();
	return <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium",
		status === "passed" ? "bg-success/10 text-success" : status === "failed" ? "bg-destructive/10 text-destructive" :
		status === "stale" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground")}>{t(STATUS_KEYS[status])}</span>;
}

export function AcceptanceCheckCard({ check, onRecheck, disabled }: { check: AcceptanceCheck; onRecheck?: () => void; disabled?: boolean }) {
	const { t } = useTranslation();
	return <article className="min-w-0 rounded-xl border border-border p-3">
		<div className="flex items-start gap-2">
			<div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium">{check.title}</div>
			<AcceptanceStatusBadge status={check.status} />
		</div>
		<p className="mt-1 text-xs text-muted-foreground">{t(check.kind === "command" ? "acceptance.command" : check.kind === "browser" ? "acceptance.browser" : "acceptance.requirement")}
			{check.exitCode !== undefined ? ` · ${t("acceptance.exitCode", { code: check.exitCode })}` : ""}
			{check.viewport ? ` · ${check.viewport.width} × ${check.viewport.height}` : ""}
		</p>
		{check.url ? <p className="mt-1 break-all text-xs text-muted-foreground">{check.url}</p> : null}
		{check.status === "stale" ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t("acceptance.staleHint")}</p> : null}
		{check.status === "unverified" && check.kind === "command" && check.exitCode === undefined ? <p className="mt-2 text-xs text-muted-foreground">{t("acceptance.noExitCode")}</p> : null}
		{check.status === "unverified" && check.uncertainCommand ? <p className="mt-2 text-xs text-muted-foreground">{t("acceptance.compoundCommand")}</p> : null}
		{check.reason ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{check.reason}</p> : null}
		{check.finishedAt ? <p className="mt-1 text-xs text-muted-foreground">{new Date(check.finishedAt).toLocaleString()}</p> : null}
		{check.output || check.evidenceToolCallIds.length ? <details className="mt-2 min-w-0 text-xs">
			<summary className="cursor-pointer text-muted-foreground">{t("acceptance.evidence")}</summary>
			<p className="mt-2 break-all text-muted-foreground">{check.evidenceToolCallIds.join(", ")}</p>
			{check.output ? <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-2 font-mono">{check.output}</pre> : null}
			{check.outputTruncated ? <p className="mt-1 text-muted-foreground">{t("acceptance.outputExcerpt")}</p> : null}
		</details> : null}
		{onRecheck ? <div className="mt-2 flex justify-end"><Button size="chip" variant="ghost" disabled={disabled} onClick={onRecheck}>{t("acceptance.recheck")}</Button></div> : null}
	</article>;
}

export function AcceptanceCenter({ report, disabled, onRequestVerification, incomplete = false }: {
	report: AcceptanceReport;
	disabled?: boolean;
	onRequestVerification?: (text: string) => void;
	incomplete?: boolean;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState("all");
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const turn = report.turns.find(turn => turn.id === selectedId) ?? report.turns.at(-1);
	const latest = report.turns.at(-1);
	if (!turn || !latest) return null;
	const passed = latest.checks.filter(check => check.status === "passed").length;
	const issues = latest.checks.filter(check => check.status === "failed" || check.status === "stale").length;
	const checks = turn.checks.filter(check => filter === "all" || check.status === filter);
	const request = (check?: AcceptanceCheck) => {
		const text = t("acceptance.recheckPrompt", { title: check?.title ?? turn.title }) +
			(check?.command ? `\n${t("acceptance.command")}: ${check.command}` : "") + (check?.url ? `\nURL: ${check.url}` : "") +
			(check?.viewport ? `\nViewport: ${check.viewport.width} × ${check.viewport.height}` : "");
		onRequestVerification?.(text); setOpen(false);
	};
	return <Dialog.Root open={open} onOpenChange={setOpen}>
		<Dialog.Trigger render={<Button size="chip" variant="ghost" className="shrink-0" title={t("acceptance.title")} />}>
			{t("acceptance.shortTitle")}
			<span className={cn("text-xs", issues ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{passed}/{latest.checks.length}</span>
		</Dialog.Trigger>
		<Dialog.Portal>
			<Dialog.Backdrop className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]" />
			<Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[48rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl outline-none">
				<div className="flex items-center justify-between gap-2">
					<Dialog.Title className="text-base font-semibold">{t("acceptance.title")}</Dialog.Title>
					<Dialog.Close render={<Button size="icon-chip" variant="ghost" aria-label={t("acceptance.close")} />}><XIcon className="size-4" /></Dialog.Close>
				</div>
				<Dialog.Description className="text-xs text-muted-foreground">{t("acceptance.scopeHint")}</Dialog.Description>
				<div className="flex flex-wrap gap-2">
					<select aria-label={t("acceptance.turn")} className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2 text-xs" value={turn.id} onChange={event => { setSelectedId(event.target.value); setCopied(false); }}>
						{[...report.turns].reverse().map(item => <option key={item.id} value={item.id}>{item.title.slice(0, 100)}</option>)}
					</select>
					<select aria-label={t("acceptance.filter")} className="rounded-lg border border-border bg-background p-2 text-xs" value={filter} onChange={event => setFilter(event.target.value)}>
						<option value="all">{t("acceptance.all")}</option>
						{Object.entries(STATUS_KEYS).map(([status, key]) => <option key={status} value={status}>{t(key)}</option>)}
					</select>
				</div>
				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
					<p className="whitespace-pre-wrap break-words text-sm">{turn.title}</p>
					{turn.streaming ? <p className="text-xs text-muted-foreground" role="status">{t("acceptance.live")}</p> : null}
					{incomplete || report.omittedTurns || turn.omittedChecks ? <p className="text-xs text-muted-foreground">{t("acceptance.historyLimit")}</p> : null}
					{turn.changedPaths.length ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("acceptance.changes", { count: turn.changedPaths.length })}</summary><ul className="mt-1 list-inside list-disc break-all">{turn.changedPaths.map(path => <li key={path}>{path}</li>)}</ul></details> : null}
					{turn.possibleShellChanges ? <p className="text-xs text-muted-foreground">{t("acceptance.shellChanges")}</p> : null}
					{checks.map(check => <AcceptanceCheckCard key={check.id} check={check} disabled={disabled} onRecheck={onRequestVerification ? () => request(check) : undefined} />)}
					{!checks.length ? <p className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">{t(turn.checks.length ? "acceptance.noMatches" : "acceptance.empty")}</p> : null}
				</div>
				{copyError ? <p role="alert" className="text-xs text-destructive">{t("acceptance.copyFailed")}</p> : null}
				<div className="flex shrink-0 flex-wrap justify-end gap-2">
					<Button size="sm" variant="secondary-outline" onClick={async () => { try { await navigator.clipboard.writeText(acceptanceMarkdown(turn)); setCopied(true); setCopyError(false); } catch { setCopyError(true); } }}>{t(copied ? "acceptance.copied" : "acceptance.copy")}</Button>
					{onRequestVerification ? <Button size="sm" disabled={disabled} onClick={() => request()}>{t("acceptance.requestVerification")}</Button> : null}
				</div>
			</Dialog.Popup>
		</Dialog.Portal>
	</Dialog.Root>;
}
