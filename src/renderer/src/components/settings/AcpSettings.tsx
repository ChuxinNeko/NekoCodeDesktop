import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import type { AcpAgentInfo, AcpSaveAgentRequest } from "../../../../shared/acp";
import { formatKeyValueLines, parseKeyValueLines, splitCommand } from "../../../../shared/mcp";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { BotIcon, PlusIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

interface Draft {
	id?: string;
	builtin: boolean;
	name: string;
	/** The whole command line, split on save — one field is what people paste. */
	commandLine: string;
	/** `KEY=value` per line. */
	env: string;
	enabled: boolean;
}

function draftOf(agent: AcpAgentInfo): Draft {
	return {
		id: agent.id,
		builtin: agent.builtin,
		name: agent.name,
		commandLine: agent.commandLine,
		env: formatKeyValueLines(agent.env),
		enabled: agent.enabled,
	};
}

const BLANK: Draft = { builtin: false, name: "", commandLine: "", env: "", enabled: true };

function toRequest(draft: Draft): AcpSaveAgentRequest {
	const { command, args } = splitCommand(draft.commandLine);
	return {
		...(draft.id ? { id: draft.id } : {}),
		name: draft.name,
		command,
		args,
		env: parseKeyValueLines(draft.env),
		enabled: draft.enabled,
	};
}

function AgentDialog({
	draft: initial,
	busy,
	error,
	onClose,
	onSave,
	onRemove,
}: {
	draft: Draft;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onSave: (draft: Draft) => void;
	/** Deletes a custom agent, or resets a built-in one. */
	onRemove?: () => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState(initial);
	// A built-in agent may leave the command empty: that runs its bundled adapter.
	const complete = !!draft.name.trim() && (draft.builtin || !!draft.commandLine.trim());
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					className={cn(
						"fixed left-1/2 top-1/2 z-50 flex max-h-[min(34rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
						"flex-col gap-3 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						"w-[32rem] max-w-[calc(100vw-3rem)]",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<Dialog.Title className="shrink-0 text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
						{t(draft.id ? "acpSettings.editTitle" : "acpSettings.addTitle")}
					</Dialog.Title>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
						<div className="flex flex-col gap-1">
							<Label>{t("acpSettings.name")}</Label>
							<Input
								placeholder="Gemini"
								value={draft.name}
								onChange={(event) => setDraft({ ...draft, name: event.target.value })}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label>{t("acpSettings.command")}</Label>
							<Input
								className="font-mono"
								placeholder={draft.builtin ? t("acpSettings.commandBundledPlaceholder") : "opencode acp"}
								value={draft.commandLine}
								onChange={(event) => setDraft({ ...draft, commandLine: event.target.value })}
							/>
							<p className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
								{t(draft.builtin ? "acpSettings.commandBundledHint" : "acpSettings.commandHint")}
							</p>
						</div>
						<div className="flex flex-col gap-1">
							<Label>{t("acpSettings.env")}</Label>
							<Textarea
								className="min-h-20 font-mono text-[length:var(--app-font-size-ui-xs,10px)]"
								placeholder={"OPENAI_API_KEY=sk-...\nCODEX_HOME=D:\\codex"}
								value={draft.env}
								onChange={(event) => setDraft({ ...draft, env: event.target.value })}
							/>
							<p className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
								{t("acpSettings.envHint")}
							</p>
						</div>
						<label className="flex items-center justify-between gap-3">
							<span className="text-[length:var(--app-font-size-ui,12px)]">{t("acpSettings.enabled")}</span>
							<Switch checked={draft.enabled} onCheckedChange={(checked: boolean) => setDraft({ ...draft, enabled: checked })} />
						</label>
						{error ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{onRemove ? (
							<Button disabled={busy} onClick={onRemove} size="sm" variant="destructive-outline">
								{t(draft.builtin ? "acpSettings.reset" : "acpSettings.remove")}
							</Button>
						) : null}
						<div className="flex-1" />
						<Button onClick={onClose} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button disabled={busy || !complete} onClick={() => onSave(draft)} size="sm" variant="subtle">
							{t("common.save")}
						</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/**
 * External agents reached over ACP — the workspaces next to NekoLocal.
 *
 * The page shows what is set up and whether it is on; how each one is launched
 * lives in a dialog, since a command line and its environment are written once
 * and then left alone. Everything here is stored and survives a restart.
 */
export function AcpSettings() {
	const { t } = useTranslation();
	const [agents, setAgents] = useState<AcpAgentInfo[]>([]);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dialogError, setDialogError] = useState<string | null>(null);

	useEffect(() => {
		void api
			.acpState()
			.then((state) => setAgents(state.agents))
			.catch((cause: unknown) => setError(errorMessage(cause)));
		return api.onAcpChanged((state) => setAgents(state.agents));
	}, []);

	const run = (action: Promise<AcpAgentInfo[]>, after?: () => void, inDialog = false) => {
		setBusy(true);
		setError(null);
		setDialogError(null);
		action
			.then((next) => {
				setAgents(next);
				after?.();
			})
			.catch((cause: unknown) => (inDialog ? setDialogError : setError)(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	return (
		<section className="flex flex-col gap-3">
			<p className="text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">
				{t("acpSettings.intro")}
			</p>
			{error ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}
			<div className="flex flex-col gap-2">
				{agents.map((agent) => (
					<div
						className="flex items-center gap-3 rounded-lg border border-[color:var(--app-surface-divider)] px-3 py-2"
						key={agent.id}
					>
						<BotIcon className="size-4 shrink-0" />
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)] font-medium">
								{agent.name}
								{agent.builtin ? (
									<span className="rounded bg-[var(--color-background-elevated-secondary)] px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground">
										{t("acpSettings.builtin")}
									</span>
								) : null}
							</span>
							<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{agent.description}
							</span>
							{agent.bundled ? (
								agent.bundled.cliPath ? (
									<span
										className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/80"
										title={agent.bundled.cliPath}
									>
										{t("acpSettings.bundledFound", { adapter: agent.bundled.adapter, cli: agent.bundled.cliName, path: agent.bundled.cliPath })}
									</span>
								) : (
									<span className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-[var(--warning)]">
										{t("acpSettings.bundledMissing", { cli: agent.bundled.cliName, hint: agent.bundled.installHint })}
									</span>
								)
							) : (
								<code className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/80" title={agent.commandLine}>
									{agent.commandLine}
								</code>
							)}
						</div>
						<Button
							disabled={busy}
							onClick={() => {
								setDialogError(null);
								setDraft(draftOf(agent));
							}}
							size="xs"
							variant="chrome-outline"
						>
							{t("common.edit")}
						</Button>
						<Switch
							aria-label={t("acpSettings.enabled")}
							checked={agent.enabled}
							disabled={busy}
							onCheckedChange={(checked: boolean) => run(api.acpSaveAgent({ ...toRequest(draftOf(agent)), enabled: checked }))}
						/>
					</div>
				))}
			</div>
			<Button
				className="self-start"
				disabled={busy}
				onClick={() => {
					setDialogError(null);
					setDraft(BLANK);
				}}
				size="xs"
				variant="chrome-outline"
			>
				<PlusIcon className="size-3.5" />
				{t("acpSettings.add")}
			</Button>
			{draft ? (
				<AgentDialog
					busy={busy}
					draft={draft}
					error={dialogError}
					onClose={() => setDraft(null)}
					onRemove={draft.id ? () => run(api.acpRemoveAgent(draft.id!), () => setDraft(null), true) : undefined}
					onSave={(next) => run(api.acpSaveAgent(toRequest(next)), () => setDraft(null), true)}
				/>
			) : null}
		</section>
	);
}
