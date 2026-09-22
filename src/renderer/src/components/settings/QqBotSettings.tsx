import { useEffect, useState } from "react";
import type { QqBotConfig, QqBotLogLevel, QqBotStatus } from "../../../../shared/qqbot";
import { api, errorMessage } from "../../api";
import { useHostDirectoryPicker } from "../HostDirectoryPicker";
import { useTranslation } from "../../i18n";
import { CopyIcon, CustomizeIcon, EraserIcon, RefreshCwIcon, TrashCanIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { QqBotDialog } from "./QqBotDialog";

const STATE_CLASS: Record<QqBotStatus["state"], string> = {
	ready: "bg-[var(--success,#16a34a)]",
	connecting: "bg-[var(--warning,#d97706)] animate-pulse",
	error: "bg-destructive",
	disabled: "bg-muted-foreground/40",
};

const LOG_CLASS: Record<QqBotLogLevel, string> = {
	info: "text-muted-foreground",
	warn: "text-[var(--warning,#d97706)]",
	error: "text-destructive",
};

/** Where the connection lives now that the config moved into a dialog. */
function summary(config: QqBotConfig): string {
	return config.protocol === "onebot" ? config.url : config.appId || "—";
}

/**
 * What the QQ bot is doing, at a glance.
 *
 * The page answers the three questions someone opens it with — is it connected,
 * who can use it, what has it been doing — and nothing else. The connection form
 * is a dialog because it is filled in once; the log is here because a QQ bot
 * fails in places the user cannot see, and without it a bot that says nothing is
 * indistinguishable from one nobody messaged.
 */
export function QqBotSettings() {
	const { t } = useTranslation();
	const pickDirectory = useHostDirectoryPicker();
	const [status, setStatus] = useState<QqBotStatus | null>(null);
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		api.qqBotStatus().then(setStatus).catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);
	// State moves on its own: the socket redials, a chat pairs, a task finishes.
	useEffect(() => api.onQqBotChanged(setStatus), []);
	// Only while a code is outstanding — a timer that runs all day to redraw
	// nothing is the kind of thing that shows up in a battery graph.
	const pairing = status?.pairing && status.pairing.expiresAt > now ? status.pairing : null;
	useEffect(() => {
		if (!status?.pairing) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [status?.pairing]);

	const run = (action: Promise<QqBotStatus>, after?: () => void) => {
		setBusy(true);
		setError(null);
		action
			.then((next) => {
				setStatus(next);
				after?.();
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const seconds = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
	const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

	return (
		<section className="flex flex-col gap-4 text-[length:var(--app-font-size-ui,12px)]">
			<p className="leading-relaxed text-muted-foreground">{t("qqbot.intro")}</p>

			{error ? (
				<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">
					{error}
				</p>
			) : null}

			<div className="flex items-center justify-between gap-4 rounded-xl border border-[color:var(--app-surface-divider)] p-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span
							aria-hidden="true"
							className={cn("size-2 shrink-0 rounded-full", STATE_CLASS[status?.state ?? "disabled"])}
						/>
						{t("qqbot.access")}
						{status ? (
							<span className="truncate font-mono text-xs text-muted-foreground">
								{t(`qqbot.protocol.${status.config.protocol}`)} · {summary(status.config)}
							</span>
						) : null}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{status?.error ?? t(`qqbot.state.${status?.state ?? "disabled"}`)}
						{status?.self ? ` · ${status.self}` : ""}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button
						aria-label={t("qqbot.reconnect")}
						disabled={busy || !status?.config.enabled}
						onClick={() => run(api.qqBotReconnect())}
						size="icon-xs"
						title={t("qqbot.reconnect")}
						variant="ghost"
					>
						<RefreshCwIcon className="size-3.5" />
					</Button>
					<Button disabled={!status} onClick={() => setEditing(true)} size="sm" variant="chrome-outline">
						<CustomizeIcon className="size-3.5" />
						{t("qqbot.configure")}
					</Button>
					<Switch
						checked={status?.config.enabled ?? false}
						disabled={busy || !status}
						onCheckedChange={(checked: boolean) => {
							if (!status) return;
							run(api.qqBotSave({ ...status.config, enabled: checked }));
						}}
					/>
				</div>
			</div>

			<section className="flex flex-col gap-3 rounded-xl border border-[color:var(--app-surface-divider)] p-4">
				<h3 className="font-medium">{t("qqbot.pair")}</h3>
				<p className="text-xs leading-relaxed text-muted-foreground">{t("qqbot.pairHint")}</p>
				{pairing ? (
					<div className="flex flex-wrap items-center gap-3">
						<code className="select-text rounded bg-muted px-3 py-2 font-mono text-2xl tracking-[0.16em]">
							{pairing.code}
						</code>
						<Button
							onClick={() => {
								void navigator.clipboard
									.writeText(pairing.code)
									.catch((cause: unknown) => setError(errorMessage(cause)));
							}}
							size="xs"
							variant="subtle"
						>
							<CopyIcon className="size-3.5" />
							{t("qqbot.copy")}
						</Button>
						<span className="text-xs tabular-nums text-muted-foreground">
							{t("qqbot.pairExpires", { time: countdown })}
						</span>
					</div>
				) : null}
				<Button
					className="self-start"
					disabled={busy || status?.state !== "ready"}
					onClick={() => run(api.qqBotPairing())}
					size="sm"
					variant={pairing ? "chrome-outline" : "subtle"}
				>
					{t(pairing ? "qqbot.newCode" : "qqbot.generateCode")}
				</Button>
				{status && status.state !== "ready" ? (
					<p className="text-xs text-muted-foreground">{t("qqbot.pairNeedsConnection")}</p>
				) : null}
			</section>

			<section className="flex flex-col gap-2">
				<h3 className="font-medium">{t("qqbot.peers")}</h3>
				{!status?.peers.length ? (
					<p className="rounded-lg border border-dashed border-[color:var(--app-surface-divider)] px-3 py-6 text-center text-xs text-muted-foreground/70">
						{t("qqbot.noPeers")}
					</p>
				) : null}
				{status?.peers.map((peer) => (
					<div key={peer.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
						<div className="min-w-0">
							<div className="truncate">{peer.label}</div>
							<p className="mt-1 truncate text-xs text-muted-foreground">
								{peer.sessionId ? `#${peer.sessionId.slice(0, 6)}` : t("qqbot.noSession")}
								{" · "}
								{t("qqbot.pairedAt", { time: new Date(peer.pairedAt).toLocaleString() })}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							{peer.busy ? (
								<span className="text-xs text-[var(--warning,#d97706)]">{t("qqbot.running")}</span>
							) : null}
							<Button
								aria-label={t("qqbot.revoke")}
								disabled={busy}
								onClick={() => run(api.qqBotRevoke(peer.id))}
								size="icon-xs"
								title={t("qqbot.revoke")}
								variant="ghost"
							>
								<TrashCanIcon className="size-3.5" />
							</Button>
						</div>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<h3 className="font-medium">{t("qqbot.log")}</h3>
					<Button
						disabled={busy || !status?.logs.length}
						onClick={() => run(api.qqBotClearLog())}
						size="xs"
						variant="ghost"
					>
						<EraserIcon className="size-3.5" />
						{t("qqbot.clearLog")}
					</Button>
				</div>
				<div className="max-h-64 overflow-y-auto rounded-lg border border-[color:var(--app-surface-divider)] bg-muted/20 p-2">
					{status?.logs.length ? (
						// Newest first: the line that explains what just went wrong should
						// not be at the bottom of a box that has to be scrolled to reach.
						[...status.logs].reverse().map((entry) => (
							<div key={entry.id} className="flex gap-2 px-1 py-0.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
								<span className="shrink-0 tabular-nums text-muted-foreground/60">
									{new Date(entry.at).toLocaleTimeString()}
								</span>
								<span className={cn("min-w-0 break-all", LOG_CLASS[entry.level])}>{entry.text}</span>
							</div>
						))
					) : (
						<p className="px-1 py-4 text-center text-xs text-muted-foreground/70">{t("qqbot.noLog")}</p>
					)}
				</div>
			</section>

			<p className="border-t border-[color:var(--app-surface-divider)] pt-4 text-xs leading-relaxed text-muted-foreground">
				{t("qqbot.commandsHint")}
			</p>

			{editing && status ? (
				<QqBotDialog
					busy={busy}
					config={status.config}
					onChooseProject={() => pickDirectory(status.config.projectPath || api.homeDir)}
					onClose={() => setEditing(false)}
					onSave={(config) => run(api.qqBotSave(config), () => setEditing(false))}
				/>
			) : null}
		</section>
	);
}
