import type { AgentSnapshot, ExecutionMode, ThinkingLevel } from "../../../shared/agent";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { CHAT_COLUMN_FRAME_CLASS_NAME, CHAT_COLUMN_GUTTER_CLASS_NAME } from "./chat/composerPickerStyles";
import { GitBranchIcon, GlobeIcon, TerminalIcon, XIcon } from "../lib/icons";

interface ChatViewProps {
	cwd: string | null;
	snapshot: AgentSnapshot | null;
	busy: boolean;
	error: string | null;
	terminalOpen: boolean;
	browserOpen: boolean;
	onPickProject: () => void;
	onSend: (text: string) => void;
	onAbort: () => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	onOpenReview: () => void;
	onToggleTerminal: () => void;
	onToggleBrowser: () => void;
	onDismissError: () => void;
}

export function ChatView(props: ChatViewProps) {
	const { cwd, snapshot, busy, error, terminalOpen } = props;

	if (!cwd) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
				<h1 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
					NekoCode Desktop
				</h1>
				<p className="max-w-sm text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					Choose a project directory to start an agent thread backed by the PI core.
				</p>
				<Button onClick={props.onPickProject} variant="subtle">
					Open project folder
				</Button>
			</div>
		);
	}

	if (!snapshot) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
				<h1 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
					No active thread
				</h1>
				<p className="max-w-sm text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					Create a new thread or pick one from the sidebar.
				</p>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
						{snapshot.thread.title}
					</span>
					<span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
						{snapshot.cells.length} cells
					</span>
				</div>
				<Button onClick={props.onOpenReview} size="xs" variant="chrome-outline">
					<GitBranchIcon className="size-3.5" />
					Review
				</Button>
				<Button
					onClick={props.onToggleBrowser}
					size="xs"
					variant={props.browserOpen ? "subtle" : "chrome-outline"}
				>
					<GlobeIcon className="size-3.5" />
					Browser
				</Button>
				<Button
					onClick={props.onToggleTerminal}
					size="xs"
					variant={terminalOpen ? "subtle" : "chrome-outline"}
				>
					<TerminalIcon className="size-3.5" />
					Terminal
				</Button>
			</header>

			{error ? (
				<div className="flex items-center gap-2 border-b border-[color:var(--app-surface-divider)] bg-destructive/6 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					<span className="min-w-0 flex-1 truncate">{error}</span>
					<Button onClick={props.onDismissError} size="icon-chip" variant="ghost">
						<XIcon className="size-3" />
					</Button>
				</div>
			) : null}

			<div className={cn("min-h-0 flex-1 overflow-y-auto py-5", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
				<div className={CHAT_COLUMN_FRAME_CLASS_NAME}>
					{snapshot.cells.length === 0 ? (
						<div className="flex flex-col gap-2 py-10 text-center">
							<h2 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
								What should we work on?
							</h2>
							<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								Tools run with the permissions of this app. Use <code>/help</code> for commands.
							</p>
						</div>
					) : (
						<Transcript cells={snapshot.cells} />
					)}
				</div>
			</div>

			<Composer
				disabled={busy}
				streaming={snapshot.streaming}
				models={snapshot.models}
				modelKey={snapshot.modelKey}
				thinkingLevel={snapshot.thinkingLevel}
				mode={snapshot.mode}
				onSend={props.onSend}
				onAbort={props.onAbort}
				onSetModel={props.onSetModel}
				onSetThinking={props.onSetThinking}
				onSetMode={props.onSetMode}
			/>
		</div>
	);
}
