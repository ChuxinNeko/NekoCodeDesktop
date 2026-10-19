import { useEffect, useState } from "react";
import type { ComposerInsertion } from "../../../shared/browser";
import type { SlashCommandSummary } from "../../../shared/commands";
import type { MentionCandidate } from "../../../shared/mentions";
import type { FusionConfig } from "../../../shared/fusion";
import type { WorkMode } from "../../../shared/workflow";
import type { AgentDefaults, ExecutionMode, SendPromptRequest, ThinkingLevel } from "../../../shared/agent";
import { api } from "../api";
import { useTranslation } from "../i18n";
import { useTheme } from "../hooks/useTheme";
import { useWallpaperPreferences } from "../hooks/useWallpaperPreferences";
import { cn } from "../lib/utils";
import { readUserName } from "../lib/onboarding";
import { BookIcon, BugIcon, CodeIcon, FlaskConicalIcon, GitPullRequestIcon, ListTodoIcon, MoonIcon, PencilIcon, SunIcon, XIcon } from "../lib/icons";
import { ComposerPickers } from "./chat/ComposerPickers";
import { AsciiWaveBackground } from "./chat/AsciiWaveBackground";
import { ComposerShell } from "./chat/ComposerShell";
import { ProjectPicker } from "./chat/ProjectPicker";
import { Button } from "./ui/button";

interface WelcomeViewProps {
	loadCommands?: () => Promise<SlashCommandSummary[]>;
	loadMentions?: (query: string) => Promise<MentionCandidate[]>;
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
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	onSetWorkMode: (mode: WorkMode) => void;
	composerHeader?: React.ReactNode;
}

const QUICK_STARTS = [
	{ key: "explore", icon: BookIcon },
	{ key: "build", icon: CodeIcon },
	{ key: "fix", icon: BugIcon },
	{ key: "review", icon: GitPullRequestIcon },
	{ key: "refactor", icon: PencilIcon },
	{ key: "test", icon: FlaskConicalIcon },
	{ key: "plan", icon: ListTodoIcon },
] as const;

/** A focused starting surface; the session reuses the same composer controls. */
export function WelcomeView(props: WelcomeViewProps) {
	const { t } = useTranslation();
	const { cwd, busy, error, defaults } = props;
	const { resolvedTheme, setTheme } = useTheme();
	const { preferences: wallpaper } = useWallpaperPreferences();
	const wallpaperOn = wallpaper.source !== "none" && wallpaper.strength > 0 && api.runtime === "electron";
	const userName = readUserName();
	const [hour, setHour] = useState(() => new Date().getHours());
	const [quickInsertion, setQuickInsertion] = useState<ComposerInsertion | null>(null);
	useEffect(() => {
		const timer = setInterval(() => setHour(new Date().getHours()), 60_000);
		return () => clearInterval(timer);
	}, []);
	const greeting = hour < 6 || hour >= 18 ? "evening" : hour < 12 ? "morning" : "afternoon";

	return (
		<div className="welcome-view relative flex min-h-0 flex-1 flex-col overflow-y-auto">
			{wallpaperOn ? null : <AsciiWaveBackground />}
			<div className="welcome-theme-toggle absolute right-5 top-5 z-10 hidden flex-col gap-1 rounded-full border border-border/70 p-1 shadow-xs sm:flex" role="group" aria-label={t("welcome.appearance")}>
				{([{ mode: "light", Icon: SunIcon }, { mode: "dark", Icon: MoonIcon }] as const).map(({ mode, Icon }) => (
					<button key={mode} type="button" aria-label={t(`theme.${mode}`)} aria-pressed={resolvedTheme === mode}
						onClick={() => setTheme(mode)}
						className={cn("flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", resolvedTheme === mode && "bg-muted text-foreground")}>
						<Icon className="size-4" />
					</button>
				))}
			</div>
			{error ? (
				<div className="relative flex items-center gap-2 border-b border-[color:var(--app-surface-divider)] bg-destructive/6 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					<span className="min-w-0 flex-1 truncate">{error}</span>
					<Button onClick={props.onDismissError} size="icon-chip" variant="ghost">
						<XIcon className="size-3" />
					</Button>
				</div>
			) : null}

			<div className="welcome-hero relative mx-auto flex w-full max-w-[44rem] flex-1 flex-col justify-center px-5 py-20 sm:px-8">
				<h1 className="mb-7 text-center text-[clamp(22px,2.5vw,28px)] font-medium leading-snug tracking-[-0.035em] text-foreground">
					{userName ? t(`welcome.greetingNamed.${greeting}`, { name: userName }) : t(`welcome.greeting.${greeting}`)}
				</h1>
				<div className="welcome-composer-card rounded-[20px] p-[3px]">
					<ComposerShell
						className="welcome-composer"
						insertion={props.insertion ?? quickInsertion}
						onInsertionConsumed={(id) => {
							if (id === quickInsertion?.id) setQuickInsertion(null);
							else props.onInsertionConsumed?.(id);
						}}
						autoFocus
						disabled={busy || !cwd}
						onSend={props.onStart}
						supportsImages={defaults?.models.find((model) => model.key === defaults.modelKey)?.imageInput === true}
						allowImageAttachments={props.allowImageAttachments}
						placeholder={t("welcome.placeholder")}
						// No session yet, so this lists the built-in skills; the session the
						// first prompt creates is what expands whatever gets picked here.
						loadCommands={props.loadCommands ?? (() => api.agentCommands())}
						// The first prompt creates the session, which is what expands these.
						loadMentions={props.loadMentions}
						toolbar={
							<>
								{defaults ? (
									<ComposerPickers
										models={defaults.models}
										modelKey={defaults.modelKey}
										fusion={defaults.fusion}
										thinkingLevel={defaults.thinkingLevel}
										thinkingLevels={defaults.thinkingLevels}
										mode={defaults.mode}
										workMode={defaults.workMode}
										agentPhase={defaults.agentPhase}
										disabled={busy}
										onSetFusion={props.onSetFusion}
										onSetModel={props.onSetModel}
										onSetThinking={props.onSetThinking}
										onSetMode={props.onSetMode}
										onSetWorkMode={props.onSetWorkMode}
									/>
								) : null}
							</>
						}
					/>
					<div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-1">
						<div className="min-w-0 max-w-full"><ProjectPicker cwd={cwd} disabled={busy} onPickProject={props.onPickProject} /></div>
						{props.composerHeader ? <div className="welcome-workspace min-w-0">{props.composerHeader}</div> : null}
					</div>
				</div>
				<div className="mt-4 flex flex-col items-center gap-2" role="group" aria-label={t("welcome.quickStarts")}>
					{[QUICK_STARTS.slice(0, 4), QUICK_STARTS.slice(4)].map((row, index) => (
						<div key={index} className="flex flex-wrap justify-center gap-2">
							{row.map(({ key, icon: Icon }) => (
								<button key={key} type="button" disabled={busy}
									onClick={() => setQuickInsertion({ id: crypto.randomUUID(), text: t(`welcome.quick.${key}.prompt`) })}
									className="welcome-quick-start inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-2 text-[12px] leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50">
									<Icon className="size-3.5" />
									{t(`welcome.quick.${key}.label`)}
								</button>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
