import type { ComposerInsertion } from "../../../shared/browser";
import type { FusionConfig } from "../../../shared/fusion";
import type { WorkMode, WorkflowAnswer } from "../../../shared/workflow";
import type { SlashCommandSummary } from "../../../shared/commands";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	AgentDefaults,
	AgentSnapshot,
	ExecutionMode,
	ThinkingLevel,
} from "../../../shared/agent";
import { useTranslation } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { WorkflowPanel } from "./chat/WorkflowPanel";
import { WorktreeBar } from "./chat/WorktreeBar";
import { Composer } from "./Composer";
import { ProjectPicker } from "./chat/ProjectPicker";
import { Transcript } from "./Transcript";
import { WelcomeView } from "./WelcomeView";
import {
	CHAT_COLUMN_FRAME_CLASS_NAME,
	CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "./chat/composerPickerStyles";
import { ArrowDownIcon, GitBranchIcon, GlobeIcon, HistoryIcon, TerminalIcon, XIcon } from "../lib/icons";
import type { CheckpointSummary } from "../../../shared/checkpoints";

/**
 * How far above the composer the newest line is parked while an answer streams,
 * as a share of the transcript's height.
 *
 * Gluing the tail to the very bottom edge meant nothing moved until the answer
 * had already reached the input box, and then every new line appeared in the
 * least readable strip of the view. Holding this gap also starts the follow
 * earlier — at 0.4 viewports of answer instead of 0.7.
 */
const FOLLOW_GAP_RATIO = 0.3;

/**
 * How close to the top of a remote transcript reaches for the page before it.
 *
 * Roughly a viewport's worth of runway, so the older turns are already in place
 * by the time the scroll gets to where they belong.
 */
const EARLIER_TRIGGER_PX = 400;

/** Bottom of the real content: the spacer below it is reserved room, not content. */
function realContentBottom(el: HTMLElement): number {
	const spacerEl = el.querySelector<HTMLElement>("[data-scroll-spacer]");
	if (!spacerEl) return el.scrollHeight;
	return spacerEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

/** The offset that parks the newest content on the follow line. */
function tailTarget(el: HTMLElement, realBottom: number): number {
	const max = Math.max(0, el.scrollHeight - el.clientHeight);
	const target = realBottom - el.clientHeight * (1 - FOLLOW_GAP_RATIO);
	return Math.min(Math.max(target, 0), max);
}

interface ChatViewProps {
	/** Keeps the same chat surface while omitting desktop-only dock controls. */
	mobile?: boolean;
	/**
	 * The transcript starts mid-session and older turns can still be fetched.
	 * Only remote surfaces set this — a local session always holds all of it.
	 */
	earlierAvailable?: boolean;
	/** A page of older turns is in flight; the trigger stays disarmed until it lands. */
	loadingEarlier?: boolean;
	onLoadEarlier?: () => void;
	/**
	 * A session was tapped and its transcript has not arrived yet. Only remote
	 * surfaces set this — a local session is already in memory when it opens.
	 */
	loadingSession?: boolean;
	/** Fetch the rest of a tool result this surface only received the head of. */
	onLoadToolOutput?: (toolCallId: string, offset: number) => Promise<{ text: string; total: number }>;
	loadCommands?: () => Promise<SlashCommandSummary[]>;
	onAnswerWorkflow?: (answer: WorkflowAnswer) => Promise<unknown>;
	onCancelWorker?: (id: string) => Promise<unknown>;
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	cwd: string | null;
	snapshot: AgentSnapshot | null;
	/** Welcome-screen picker state — what the next new session starts with. */
	defaults: AgentDefaults | null;
	busy: boolean;
	error: string | null;
	terminalOpen: boolean;
	browserAvailable?: boolean;
	browserOpen: boolean;
	onPickProject: () => void;
	onSend: (text: string) => void;
	/**
	 * Run this prompt as a task of its own without leaving the open session.
	 * Absent on surfaces that cannot hold more than one task at a time.
	 */
	onSendBackground?: (text: string) => void;
	onAbort: () => void;
	onSetFusion: (config: FusionConfig) => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	onSetWorkMode: (mode: WorkMode) => void;
	onOpenReview?: () => void;
	onToggleTerminal: () => void;
	onToggleBrowser: () => void;
	/** Show one background worker's full run in the right dock. */
	onOpenTask?: (taskId: string) => void;
	/** Show a file a tool row references in the dock's Files pane. */
	onOpenFile?: (path: string) => void;
	onDismissError: () => void;
	/** Opens a session in `cwd` and sends this as its first prompt. */
	onStartSession: (text: string) => void;
	/** Ask to rewind to a checkpoint; the confirmation is App's to show. */
	onRestoreCheckpoint?: (checkpoint: CheckpointSummary) => void;
	/** Show the list of every restore point in the right dock. */
	onOpenCheckpoints: () => void;
	/** This task's isolated checkout was merged or thrown away. */
	onWorktreeReleased?: () => void;
	onWorktreeError?: (message: string) => void;
}

export function ChatView(props: ChatViewProps) {
	const { t } = useTranslation();
	const { cwd, snapshot, busy, error, terminalOpen } = props;

	// --- transcript auto-scroll ------------------------------------------------
	// On send, the new turn's prompt is scrolled to ~30% from the top and the
	// answer streams below it — a one-shot move, then control is the user's.
	// The bottom spacer reserves scroll room so the anchor is reachable before
	// the answer has produced anything, and so the tail can be held a gap above
	// the composer rather than against it. "bottom" follows the tail of the
	// *real* content (spacer excluded); null means the user scrolled — never
	// pull back.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef<"bottom" | null>("bottom");
	const expectedScrollRef = useRef<number | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const lastUserCellRef = useRef<string | null>(null);
	const [jumpVisible, setJumpVisible] = useState(false);
	const [spacerPx, setSpacerPx] = useState(0);
	/** Where the viewport sat when a page of older turns was asked for. */
	const prependRef = useRef<{ firstId: string; scrollHeight: number; scrollTop: number } | null>(null);

	/**
	 * Reach for older turns once the user has scrolled up to them.
	 *
	 * The scroll position is recorded here rather than when the cells arrive:
	 * by then the content above has already changed height, and the number
	 * needed to put the viewport back is the one from before it did.
	 */
	const requestEarlier = (el: HTMLDivElement) => {
		if (!props.earlierAvailable || props.loadingEarlier || !props.onLoadEarlier) return;
		if (prependRef.current || el.scrollTop > EARLIER_TRIGGER_PX) return;
		const firstId = snapshot?.cells[0]?.id;
		if (!firstId) return;
		prependRef.current = { firstId, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
		props.onLoadEarlier();
	};

	// A request that failed, or found nothing, must not disarm the trigger for good.
	useEffect(() => {
		if (!props.loadingEarlier) prependRef.current = null;
	}, [props.loadingEarlier]);

	// The spacer only exists while a session is open; re-measure with the window.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () => setSpacerPx(Math.round(el.clientHeight * 0.65));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [snapshot !== null]);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!snapshot) {
			sessionIdRef.current = null;
			lastUserCellRef.current = null;
			return;
		}
		if (!el) return;

		const sessionChanged = snapshot.session.id !== sessionIdRef.current;
		sessionIdRef.current = snapshot.session.id;
		let lastUserId: string | null = null;
		for (let i = snapshot.cells.length - 1; i >= 0; i--) {
			if (snapshot.cells[i].type === "user") {
				lastUserId = snapshot.cells[i].id;
				break;
			}
		}
		const newTurn = lastUserId !== null && lastUserId !== lastUserCellRef.current;
		if (lastUserId) lastUserCellRef.current = lastUserId;

		const pending = prependRef.current;
		if (pending && sessionChanged) prependRef.current = null;
		else if (pending && snapshot.cells[0]?.id !== pending.firstId) {
			// Older turns landed above the viewport. Everything the user was looking
			// at moved down by however much arrived; put the scroll back onto it.
			prependRef.current = null;
			const target = Math.max(0, pending.scrollTop + (el.scrollHeight - pending.scrollHeight));
			expectedScrollRef.current = target;
			el.scrollTop = target;
			setJumpVisible(realContentBottom(el) - target - el.clientHeight > 80);
			return;
		}

		if (sessionChanged) followRef.current = "bottom";
		// Sending re-engages following even if the user had scrolled away.
		else if (newTurn) followRef.current = "bottom";

		// Content bottom ignoring the spacer — "latest" means this edge.
		const realBottom = realContentBottom(el);
		const updateJump = () => setJumpVisible(realBottom - el.scrollTop - el.clientHeight > 80);

		if (followRef.current === "bottom") {
			const max = Math.max(0, el.scrollHeight - el.clientHeight);
			// Tail-follow: hold the real content bottom on the follow line.
			let target = tailTarget(el, realBottom);
			if (newTurn) {
				// A fresh prompt parks at middle-upper — 30% of the viewport height
				// above it, the spacer guarantees the room. From the next tick on,
				// tail-follow takes over as the answer grows past that space.
				const anchorEl = el.querySelector<HTMLElement>("[data-turn-anchor]");
				if (anchorEl) {
					const anchorTop =
						anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
					target = Math.min(Math.max(anchorTop - el.clientHeight * 0.3, 0), max);
				}
			} else {
				// Mid-turn the target only ever moves down — when the answer is
				// still short the bottom target sits above the parked anchor, and
				// chasing it would drag the prompt back down.
				target = Math.max(el.scrollTop, target);
			}
			if (Math.abs(target - el.scrollTop) > 1) {
				expectedScrollRef.current = target;
				el.scrollTop = target;
			}
		}
		updateJump();
		requestEarlier(el);
	}, [snapshot, spacerPx]);

	const onTranscriptScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const expected = expectedScrollRef.current;
		expectedScrollRef.current = null;
		const realBottom = realContentBottom(el);
		const distFromBottom = realBottom - el.scrollTop - el.clientHeight;
		if (expected === null || Math.abs(el.scrollTop - expected) > 2) {
			// A scroll we did not cause: re-engage tail-follow once the user has
			// caught up with the latest content. Anything at or past the bottom
			// edge counts, because the follow line itself sits below it.
			followRef.current = distFromBottom < 40 ? "bottom" : null;
		}
		setJumpVisible(distFromBottom > 80);
		requestEarlier(el);
	};

	const jumpToLatest = () => {
		const el = scrollRef.current;
		if (!el) return;
		followRef.current = "bottom";
		// Land where following would hold it, so the button and the stream agree.
		const target = tailTarget(el, realContentBottom(el));
		expectedScrollRef.current = target;
		el.scrollTop = target;
		setJumpVisible(false);
	};

	// A session was opened and its transcript is still in flight. The chat
	// surface has nothing to draw until it lands, but the welcome screen would
	// be plainly wrong — and holding the tap until the fetch returns is what
	// made opening a session feel like it had not registered at all.
	if (!snapshot && props.loadingSession) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
				{error ? (
					<p className="text-[length:var(--app-font-size-ui,12px)] text-destructive">{error}</p>
				) : (
					<>
						<Spinner className="size-4 text-muted-foreground" />
						<p className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
							{t("chat.openingSession")}
						</p>
					</>
				)}
			</div>
		);
	}

	// No open session — including the very first launch — lands on the welcome
	// screen, which is itself a way to start one rather than a dead end.
	if (!snapshot) {
		return (
			<WelcomeView
				loadCommands={props.loadCommands}
				insertion={props.insertion}
				onInsertionConsumed={props.onInsertionConsumed}
				busy={busy}
				cwd={cwd}
				defaults={props.defaults}
				error={error}
				onDismissError={props.onDismissError}
				onPickProject={props.onPickProject}
				onSetMode={props.onSetMode}
				onSetWorkMode={props.onSetWorkMode}
				onSetFusion={props.onSetFusion}
				onSetModel={props.onSetModel}
				onSetThinking={props.onSetThinking}
				onStart={props.onStartSession}
			/>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<div className="min-w-0 max-w-[50%]">
						<ProjectPicker cwd={snapshot.session.cwd} disabled={busy} onPickProject={props.onPickProject} />
					</div>
					<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
						{snapshot.session.titlePending
							? t("sessions.pendingTitle")
							: snapshot.session.title}
					</span>
					<span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
						{t("chat.cells", { count: snapshot.cells.length })}
					</span>
				</div>
				{!props.mobile && <><Button onClick={props.onOpenCheckpoints} size="xs" variant="chrome-outline">
					<HistoryIcon className="size-3.5" />
					{t("checkpoint.panelTitle")}
				</Button>
				<Button onClick={props.onOpenReview} size="xs" variant="chrome-outline">
					<GitBranchIcon className="size-3.5" />
					{t("nav.review")}
				</Button>
				{props.browserAvailable !== false ? (
					<Button
						onClick={props.onToggleBrowser}
						size="xs"
						variant={props.browserOpen ? "subtle" : "chrome-outline"}
					>
						<GlobeIcon className="size-3.5" />
						{t("nav.browser")}
					</Button>
				) : null}
				<Button
					onClick={props.onToggleTerminal}
					size="xs"
					variant={terminalOpen ? "subtle" : "chrome-outline"}
				>
					<TerminalIcon className="size-3.5" />
					{t("chat.terminal")}
				</Button>
				</>}
			</header>

			{/* Desktop only: the phone client reaches tasks over the LAN API, which
			    has no way to act on a checkout sitting on the desktop's disk. */}
			{!props.mobile ? (
				<WorktreeBar
					key={snapshot.session.id}
					sessionId={snapshot.session.id}
					title={snapshot.session.title}
					streaming={snapshot.streaming}
					onReleased={props.onWorktreeReleased ?? (() => undefined)}
					onError={props.onWorktreeError ?? (() => undefined)}
				/>
			) : null}

			{error ? (
				<div className="flex items-center gap-2 border-b border-[color:var(--app-surface-divider)] bg-destructive/6 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					<span className="min-w-0 flex-1 truncate">{error}</span>
					<Button onClick={props.onDismissError} size="icon-chip" variant="ghost">
						<XIcon className="size-3" />
					</Button>
				</div>
			) : null}

			<div className="relative flex min-h-0 flex-1 flex-col">
				<div
					ref={scrollRef}
					onScroll={onTranscriptScroll}
					className={cn("min-h-0 flex-1 overflow-y-auto py-5", CHAT_COLUMN_GUTTER_CLASS_NAME)}
				>
					<div className={CHAT_COLUMN_FRAME_CLASS_NAME}>
						{snapshot.cells.length === 0 ? (
							<div className="flex flex-col gap-2 py-10 text-center">
								<h2 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
									{t("chat.emptyTitle")}
								</h2>
								<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
									{t("chat.emptyHintPre")} <code>/help</code> {t("chat.emptyHintPost")}
								</p>
							</div>
						) : (
							<>
							{props.loadingEarlier ? (
								<div className="flex items-center justify-center gap-2 pb-4 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
									<Spinner className="size-3" />
									{t("chat.loadingEarlier")}
								</div>
							) : null}
							<Transcript
							cells={snapshot.cells}
							streaming={snapshot.streaming}
							tasks={snapshot.workflow.tasks}
							onOpenTask={props.onOpenTask}
							onOpenFile={props.onOpenFile}
							checkpoints={snapshot.checkpoints}
							onRestoreCheckpoint={props.onRestoreCheckpoint}
							onOpenReview={props.onOpenReview}
							onLoadToolOutput={props.onLoadToolOutput}
						/>
							</>
						)}
					</div>
					{/* Scroll headroom: lets a fresh turn's prompt reach its middle-upper
					    position before the answer has produced anything. "Latest" and
					    jump-to-bottom targets all stop at this spacer's top edge. */}
					<div aria-hidden="true" data-scroll-spacer style={{ height: spacerPx }} />
				</div>
				{jumpVisible ? (
					<Button
						className="absolute bottom-3 right-4 z-10 shadow-md"
						onClick={jumpToLatest}
						shape="capsule"
						size="chip"
						variant="secondary-outline"
					>
						<ArrowDownIcon className="size-3.5" />
						{t("chat.jumpToLatest")}
					</Button>
				) : null}
			</div>

			<WorkflowPanel workflow={snapshot.workflow} onOpenTask={props.onOpenTask} onAnswer={props.onAnswerWorkflow} onCancelWorker={props.onCancelWorker} />
			<Composer
				loadCommands={props.loadCommands}
				insertion={props.insertion}
				onInsertionConsumed={props.onInsertionConsumed}
				disabled={busy || !!snapshot.workflow.request}
				streaming={
					snapshot.streaming || snapshot.workflow.tasks.some((task) => task.status === "running")
				}
				models={snapshot.models}
				modelKey={snapshot.modelKey}
				fusion={snapshot.fusion}
				thinkingLevel={snapshot.thinkingLevel}
				thinkingLevels={snapshot.thinkingLevels}
				mode={snapshot.mode}
				workMode={snapshot.workMode}
				agentPhase={snapshot.agentPhase}
				onSend={props.onSend}
				onSendBackground={props.onSendBackground}
				onAbort={props.onAbort}
				onSetFusion={props.onSetFusion}
				onSetModel={props.onSetModel}
				onSetThinking={props.onSetThinking}
				onSetMode={props.onSetMode}
				onSetWorkMode={props.onSetWorkMode}
			/>
		</div>
	);
}
