import type { AgentDefaults, ExecutionMode, ThinkingLevel } from "../../../shared/agent";
import { shortenPath } from "../../../shared/paths";
import { api } from "../api";
import { useTranslation } from "../i18n";
import { FolderOpenIcon, XIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { ComposerPickers } from "./chat/ComposerPickers";
import { ComposerShell } from "./chat/ComposerShell";
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "./chat/composerPickerStyles";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface WelcomeViewProps {
	cwd: string | null;
	busy: boolean;
	error: string | null;
	/** Picker state for the next new session; null until the main process answers. */
	defaults: AgentDefaults | null;
	onPickProject: () => void;
	/** Starts a session in `cwd` and sends this as its opening prompt. */
	onStart: (text: string) => void;
	onDismissError: () => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
}

/**
 * What the chat surface shows before a session is open: the prompt that starts
 * one.
 *
 * The composer sits at the bottom, in the same place it occupies during a
 * session, so sending the first prompt swaps the content above it without the
 * input moving. Its toolbar carries the working directory plus the same
 * model/thinking/mode pickers a session shows — the picks are held in the main
 * process and applied when the session is created.
 */
export function WelcomeView(props: WelcomeViewProps) {
	const { t } = useTranslation();
	const { cwd, busy, error, defaults } = props;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
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
				autoFocus
				disabled={busy || !cwd}
				onSend={props.onStart}
				placeholder={t("composer.placeholder")}
				toolbar={
					<>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										className={cn(
											COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
											"border-transparent",
										)}
										onClick={props.onPickProject}
										size="chip"
										variant="ghost"
									/>
								}
							>
								<FolderOpenIcon className="size-3.5" />
								<span className="truncate text-[var(--color-text-foreground-secondary)]">
									{cwd ? shortenPath(cwd, api.homeDir) : t("welcome.chooseFolder")}
								</span>
							</TooltipTrigger>
							<TooltipPopup side="top">
								{cwd ? t("welcome.workingIn", { cwd }) : t("welcome.chooseWorkingDir")}
							</TooltipPopup>
						</Tooltip>
						{defaults ? (
							<ComposerPickers
								models={defaults.models}
								modelKey={defaults.modelKey}
								thinkingLevel={defaults.thinkingLevel}
								thinkingLevels={defaults.thinkingLevels}
								mode={defaults.mode}
								onSetModel={props.onSetModel}
								onSetThinking={props.onSetThinking}
								onSetMode={props.onSetMode}
							/>
						) : null}
					</>
				}
			/>
		</div>
	);
}
