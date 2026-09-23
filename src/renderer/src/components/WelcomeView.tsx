import type { ComposerInsertion } from "../../../shared/browser";
import type { SlashCommandSummary } from "../../../shared/commands";
import type { FastContextConfig } from "../../../shared/fast-context";
import type { FusionConfig } from "../../../shared/fusion";
import type { WorkMode } from "../../../shared/workflow";
import type { AgentDefaults, ExecutionMode, SendPromptRequest, ThinkingLevel } from "../../../shared/agent";
import { api } from "../api";
import { useTranslation } from "../i18n";
import { XIcon } from "../lib/icons";
import { ComposerPickers } from "./chat/ComposerPickers";
import { ComposerShell } from "./chat/ComposerShell";
import { ProjectPicker } from "./chat/ProjectPicker";
import { Button } from "./ui/button";

interface WelcomeViewProps {
	loadCommands?: () => Promise<SlashCommandSummary[]>;
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	cwd: string | null;
	busy: boolean;
	error: string | null;
	/** Picker state for the next new session; null until the main process answers. */
	defaults: AgentDefaults | null;
	onPickProject: () => void;
	/** Starts a session in `cwd` and sends this as its opening prompt. */
	onStart: (request: SendPromptRequest) => void;
	allowImageAttachments?: boolean;
	onDismissError: () => void;
	onSetFusion: (config: FusionConfig) => void;
	onSetFastContext: (config: FastContextConfig) => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	onSetWorkMode: (mode: WorkMode) => void;
}

/**
 * What the chat surface shows before a session is open: the prompt that starts
 * one.
 *
 * The composer sits at the bottom, in the same place it occupies during a
 * session, so sending the first prompt swaps the content above it without the
 * input moving. The header carries the working directory; the toolbar has the same
 * model/thinking/mode pickers a session shows — the picks are held in the main
 * process and applied when the session is created.
 */
export function WelcomeView(props: WelcomeViewProps) {
	const { t } = useTranslation();
	const { cwd, busy, error, defaults } = props;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<ProjectPicker cwd={cwd} disabled={busy} onPickProject={props.onPickProject} />
			</header>
			{error ? (
				<div className="flex items-center gap-2 border-b border-[color:var(--app-surface-divider)] bg-destructive/6 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					<span className="min-w-0 flex-1 truncate">{error}</span>
					<Button onClick={props.onDismissError} size="icon-chip" variant="ghost">
						<XIcon className="size-3" />
					</Button>
				</div>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
				<h1 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
					{t("welcome.title")}
				</h1>
				<p className="max-w-md text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("welcome.subtitle")}
				</p>
			</div>

			<ComposerShell
				insertion={props.insertion}
				onInsertionConsumed={props.onInsertionConsumed}
				autoFocus
				disabled={busy || !cwd}
				onSend={props.onStart}
				supportsImages={defaults?.models.find((model) => model.key === defaults.modelKey)?.imageInput === true}
				allowImageAttachments={props.allowImageAttachments}
				placeholder={t("composer.placeholder")}
				// No session yet, so this lists the built-in skills; the session the
				// first prompt creates is what expands whatever gets picked here.
				loadCommands={props.loadCommands ?? (() => api.agentCommands())}
				toolbar={
					<>
						{defaults ? (
							<ComposerPickers
								models={defaults.models}
								modelKey={defaults.modelKey}
								fastContext={defaults.fastContext}
								fusion={defaults.fusion}
								thinkingLevel={defaults.thinkingLevel}
								thinkingLevels={defaults.thinkingLevels}
								mode={defaults.mode}
								workMode={defaults.workMode}
								agentPhase={defaults.agentPhase}
								disabled={busy}
								onSetFusion={props.onSetFusion}
								onSetFastContext={props.onSetFastContext}
								onSetModel={props.onSetModel}
								onSetThinking={props.onSetThinking}
								onSetMode={props.onSetMode}
								onSetWorkMode={props.onSetWorkMode}
							/>
						) : null}
					</>
				}
			/>
		</div>
	);
}
