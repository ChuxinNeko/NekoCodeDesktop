import { useCallback, useLayoutEffect, useRef } from "react";
import type {
	AcpAgentInfo,
	AcpConfigOption,
	AcpPermissionRequest,
	AcpSessionSnapshot,
	AcpSessionStatus,
} from "../../../../shared/acp";
import type { SendPromptRequest } from "../../../../shared/agent";
import type { SlashCommandSummary } from "../../../../shared/commands";
import type { ComposerInsertion } from "../../../../shared/browser";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { ChevronDownIcon, TriangleAlertIcon, XIcon } from "../../lib/icons";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Transcript } from "../Transcript";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { ComposerShell } from "../chat/ComposerShell";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { ProjectPicker } from "../chat/ProjectPicker";
import {
	COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
	COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
} from "../chat/composerPickerStyles";

const STATUS_KEYS: Record<AcpSessionStatus, TranslationKey> = {
	starting: "acp.status.starting",
	ready: "acp.status.ready",
	prompting: "acp.status.prompting",
	error: "acp.status.error",
};

function StatusDot({ status }: { status: AcpSessionStatus }) {
	if (status === "starting" || status === "prompting") {
		return <Spinner className="size-3 shrink-0 text-muted-foreground" />;
	}
	return (
		<span
			className={cn(
				"size-1.5 shrink-0 rounded-full",
				status === "error" ? "bg-destructive" : "bg-[var(--success)]",
			)}
		/>
	);
}

function ConfigPicker({
	option,
	disabled,
	onChange,
}: {
	option: AcpConfigOption;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const current = option.options.find((entry) => entry.value === option.currentValue);
	return (
		<Menu>
			<MenuTrigger
				disabled={disabled}
				render={
					<Button
						// Agents publish as many settings as they like (Codex has five), so a
						// picker gives up width and truncates rather than run under send.
						className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "min-w-0 shrink border-transparent")}
						disabled={disabled}
						size="chip"
						title={`${option.name}: ${current?.name ?? option.currentValue}`}
						variant="ghost"
					>
						<span className="truncate">{current?.name ?? option.name}</span>
						<ChevronDownIcon className="size-3 opacity-60" />
					</Button>
				}
			/>
			<ComposerPickerMenuPopup align="start" className="max-h-80 overflow-y-auto" side="top">
				<MenuRadioGroup onValueChange={(value) => onChange(value as string)} value={option.currentValue}>
					<MenuGroupLabel>{option.name}</MenuGroupLabel>
					{option.options.map((entry) => (
						<MenuRadioItem
							className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
							key={entry.value}
							title={entry.description}
							value={entry.value}
						>
							<span className="truncate">{entry.name}</span>
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</ComposerPickerMenuPopup>
		</Menu>
	);
}

function PermissionCard({
	request,
	agentName,
	onRespond,
}: {
	request: AcpPermissionRequest;
	agentName: string;
	onRespond: (optionId: string | null) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-border bg-[var(--app-user-message-background)] p-3">
			<div className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
				<TriangleAlertIcon className="size-3.5 shrink-0" />
				<span className={MUTED_LABEL_TEXT_CLASS_NAME}>{t("acp.permission.title", { agent: agentName })}</span>
			</div>
			<p className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium">{request.title}</p>
			{request.detail ? (
				<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 px-2 py-1.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
					{request.detail}
				</pre>
			) : null}
			<div className="flex flex-wrap gap-1.5">
				{request.options.map((option) => (
					<Button
						key={option.optionId}
						onClick={() => onRespond(option.optionId)}
						size="xs"
						variant={option.kind.startsWith("allow") ? "default" : "outline"}
					>
						{option.name}
					</Button>
				))}
				{request.options.some((option) => option.kind.startsWith("reject")) ? null : (
					<Button onClick={() => onRespond(null)} size="xs" variant="outline">
						{t("acp.permission.cancel")}
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * The transcript sticks to the bottom while the user is there, and stays put
 * once they scroll up to read something.
 */
function useStickToBottom(dependency: unknown) {
	const ref = useRef<HTMLDivElement | null>(null);
	const stuck = useRef(true);
	const onScroll = useCallback(() => {
		const element = ref.current;
		if (!element) return;
		stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
	}, []);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element && stuck.current) element.scrollTop = element.scrollHeight;
	}, [dependency]);
	return { ref, onScroll, stick: () => (stuck.current = true) };
}

interface AcpChatViewProps {
	agent: AcpAgentInfo;
	/** Text to drop into the composer — an element picked in the browser panel. */
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	/** The open conversation, or null for the empty composer of a new one. */
	snapshot: AcpSessionSnapshot | null;
	cwd: string | null;
	error: string | null;
	/** The agent could not list its own history. */
	historyError: string | null;
	composerHeader: React.ReactNode;
	onDismissError: () => void;
	onPickProject: () => void;
	onSend: (request: SendPromptRequest) => void;
	onAbort: () => void;
	onSetConfig: (configId: string, value: string) => void;
	onRespondPermission: (requestId: string, optionId: string | null) => void;
}

/**
 * A conversation with an external agent, in the same frame as NekoLocal's: the
 * transcript renders through the shared `Transcript`, and the composer stays
 * where it always is so switching workspaces does not move the input.
 */
export function AcpChatView(props: AcpChatViewProps) {
	const { t } = useTranslation();
	const { agent, snapshot } = props;
	const scroll = useStickToBottom(snapshot?.cells);
	// A session opened for a message not yet sent still reads as a new
	// conversation — its only visible part is the pickers it brought along.
	const fresh = !snapshot || (snapshot.pristine && snapshot.cells.length === 0);
	const busy = !fresh && snapshot?.status === "starting" && snapshot.cells.length === 0;
	const commands = useCallback(
		(): Promise<SlashCommandSummary[]> =>
			Promise.resolve(
				(snapshot?.commands ?? []).map((command) => ({
					name: command.name,
					description: command.description,
					kind: "prompt" as const,
					...(command.hint ? { argumentHint: command.hint } : {}),
				})),
			),
		[snapshot?.commands],
	);
	const error = snapshot?.error ?? props.error;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				{snapshot && !fresh ? (
					<div className={cn("flex min-w-0 flex-1 items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						<StatusDot status={snapshot.status} />
						<span className="shrink-0 font-medium text-foreground">{agent.name}</span>
						<span className="min-w-0 truncate text-foreground">{snapshot.title}</span>
						<span className="min-w-0 flex-1 truncate" title={snapshot.cwd}>
							{snapshot.cwd}
						</span>
						<span className="shrink-0">{t(STATUS_KEYS[snapshot.status])}</span>
					</div>
				) : (
					<ProjectPicker cwd={props.cwd} onPickProject={props.onPickProject} />
				)}
			</header>
			{error ? (
				<div className="flex items-start gap-2 border-b border-[color:var(--app-surface-divider)] bg-destructive/6 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
					{snapshot?.error ? null : (
						<Button onClick={props.onDismissError} size="icon-chip" variant="ghost">
							<XIcon className="size-3" />
						</Button>
					)}
				</div>
			) : null}

			{snapshot && !fresh ? (
				<div className="min-h-0 flex-1 overflow-y-auto" onScroll={scroll.onScroll} ref={scroll.ref}>
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
						{busy ? (
							<div className={cn("flex items-center justify-center gap-2 py-10 text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
								<Spinner className="size-3.5" />
								{t("acp.startingHint", { agent: agent.name })}
							</div>
						) : null}
						<Transcript cells={snapshot.cells} streaming={snapshot.streaming} />
					</div>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
					<h1 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
						{t("acp.welcomeTitle", { agent: agent.name })}
					</h1>
					<p className="max-w-md text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("acp.welcomeSubtitle", { agent: agent.name })}
					</p>
					{snapshot?.status === "starting" ? (
						<p className={cn("flex items-center gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
							<Spinner className="size-3" />
							{t("acp.warming", { agent: agent.name })}
						</p>
					) : null}
					{props.historyError ? (
						<p className="max-w-md text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
							{t("acp.historyUnavailable", { error: props.historyError })}
						</p>
					) : null}
				</div>
			)}

			{snapshot && snapshot.permissions.length > 0 ? (
				<div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-2">
					{snapshot.permissions.map((request) => (
						<PermissionCard
							agentName={agent.name}
							key={request.id}
							onRespond={(optionId) => props.onRespondPermission(request.id, optionId)}
							request={request}
						/>
					))}
				</div>
			) : null}
			<ComposerShell
				insertion={props.insertion}
				onInsertionConsumed={props.onInsertionConsumed}
				allowImageAttachments={snapshot ? snapshot.supportsImages : true}
				autoFocus
				context={snapshot?.context}
				// An unsent conversation that failed to start is replaced on send.
				disabled={!props.cwd || (snapshot?.status === "error" && !snapshot.pristine)}
				header={props.composerHeader}
				loadCommands={snapshot ? commands : undefined}
				onAbort={props.onAbort}
				onSend={(request) => {
					scroll.stick();
					props.onSend(request);
				}}
				placeholder={t("acp.placeholder", { agent: agent.name })}
				streaming={snapshot?.streaming ?? false}
				supportsImages={snapshot ? snapshot.supportsImages : true}
				toolbar={
					<div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
						{(snapshot?.configOptions ?? []).map((option) => (
							<ConfigPicker
								disabled={snapshot?.status !== "ready"}
								key={option.id}
								onChange={(value) => props.onSetConfig(option.id, value)}
								option={option}
							/>
						))}
					</div>
				}
			/>
		</div>
	);
}
