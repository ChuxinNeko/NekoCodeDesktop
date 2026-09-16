import { useLayoutEffect, useRef, useState } from "react";
import type { AgentDefaults, AgentSnapshot, ExecutionMode, ThinkingLevel } from "../../../shared/agent";
import { useTranslation } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { WelcomeView } from "./WelcomeView";
import { CHAT_COLUMN_FRAME_CLASS_NAME, CHAT_COLUMN_GUTTER_CLASS_NAME } from "./chat/composerPickerStyles";
import { ArrowDownIcon, GitBranchIcon, GlobeIcon, TerminalIcon, XIcon } from "../lib/icons";

interface ChatViewProps {
	cwd: string | null;
	snapshot: AgentSnapshot | null;
	/** Welcome-screen picker state — what the next new session starts with. */
	defaults: AgentDefaults | null;
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
	/** Opens a session in `cwd` and sends this as its first prompt. */
	onStartSession: (text: string) => void;
}

export function ChatView(props: ChatViewProps) {
	const { t } = useTranslation();
	const { cwd, snapshot, busy, error, terminalOpen } = props;

	// --- transcript auto-scroll ------------------------------------------------
	// On send, the new turn's prompt is scrolled to ~30% from the top and the
	// answer streams below it — a one-shot move, then control is the user's.
	// The bottom spacer reserves scroll room so the anchor is reachable before
	// the answer has produced anything. "bottom" follows the tail of the *real*
	// content (spacer excluded); null means the user scrolled — never pull back.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef<"bottom" | null>("bottom");
	const expectedScrollRef = useRef<number | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const lastUserCellRef = useRef<string | null>(null);
	const [jumpVisible, setJumpVisible] = useState(false);
	const [spacerPx, setSpacerPx] = useState(0);

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

		if (sessionChanged) followRef.current = "bottom";
		// Sending re-engages following even if the user had scrolled away.
		else if (newTurn) followRef.current = "bottom";

		const spacerEl = el.querySelector<HTMLElement>("[data-scroll-spacer]");
		// Content bottom ignoring the spacer — "latest" means this edge.
		const realBottom = spacerEl
			? spacerEl.getBoundingClientRect().top -
				el.getBoundingClientRect().top +
				el.scrollTop
			: el.scrollHeight;
		const updateJump = () =>
			setJumpVisible(realBottom - el.scrollTop - el.clientHeight > 80);

		if (followRef.current === "bottom") {
			const max = Math.max(0, el.scrollHeight - el.clientHeight);
			// Tail-follow: glue the real content bottom to the viewport edge.
			let target = Math.min(Math.max(realBottom - el.clientHeight, 0), max);
			if (newTurn) {
				// A fresh prompt parks at middle-upper — 30% of the viewport height
				// above it, the spacer guarantees the room. From the next tick on,
				// tail-follow takes over as the answer grows past that space.
				const anchorEl = el.querySelector<HTMLElement>("[data-turn-anchor]");
				if (anchorEl) {
					const anchorTop =
						anchorEl.getBoundingClientRect().top -
						el.getBoundingClientRect().top +
						el.scrollTop;
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
	}, [snapshot, spacerPx]);

	const onTranscriptScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const expected = expectedScrollRef.current;
		expectedScrollRef.current = null;
		const spacerEl = el.querySelector<HTMLElement>("[data-scroll-spacer]");
		const realBottom = spacerEl
			? spacerEl.getBoundingClientRect().top -
				el.getBoundingClientRect().top +
				el.scrollTop
			: el.scrollHeight;
		const distFromBottom = realBottom - el.scrollTop - el.clientHeight;
		if (expected === null || Math.abs(el.scrollTop - expected) > 2) {
			// A scroll we did not cause: re-engage tail-follow only when the user
			// deliberately lands on the real bottom edge — parking inside the
			// spacer's dead space does not count.
			followRef.current = Math.abs(distFromBottom) < 40 ? "bottom" : null;
		}
		setJumpVisible(distFromBottom > 80);
	};

	const jumpToLatest = () => {
		const el = scrollRef.current;
		if (!el) return;
		followRef.current = "bottom";
		const spacerEl = el.querySelector<HTMLElement>("[data-scroll-spacer]");
		const realBottom = spacerEl
			? spacerEl.getBoundingClientRect().top -
				el.getBoundingClientRect().top +
				el.scrollTop
			: el.scrollHeight;
		const max = Math.max(0, el.scrollHeight - el.clientHeight);
		const target = Math.min(Math.max(realBottom - el.clientHeight, 0), max);
		expectedScrollRef.current = target;
		el.scrollTop = target;
		setJumpVisible(false);
	};

	// No open session — including the very first launch — lands on the welcome
	// screen, which is itself a way to start one rather than a dead end.
	if (!snapshot) {
		return (
			<WelcomeView
				busy={busy}
				cwd={cwd}
				defaults={props.defaults}
				error={error}
				onDismissError={props.onDismissError}
				onPickProject={props.onPickProject}
				onSetMode={props.onSetMode}
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
					<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
						{snapshot.session.title}
					</span>
					<span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
						{t("chat.cells", { count: snapshot.cells.length })}
					</span>
				</div>
				<Button onClick={props.onOpenReview} size="xs" variant="chrome-outline">
					<GitBranchIcon className="size-3.5" />
					{t("nav.review")}
				</Button>
				<Button
					onClick={props.onToggleBrowser}
					size="xs"
					variant={props.browserOpen ? "subtle" : "chrome-outline"}
				>
					<GlobeIcon className="size-3.5" />
					{t("nav.browser")}
				</Button>
				<Button
					onClick={props.onToggleTerminal}
					size="xs"
					variant={terminalOpen ? "subtle" : "chrome-outline"}
				>
					<TerminalIcon className="size-3.5" />
					{t("chat.terminal")}
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
							<Transcript cells={snapshot.cells} streaming={snapshot.streaming} />
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

			<Composer
				disabled={busy}
				streaming={snapshot.streaming}
				models={snapshot.models}
				modelKey={snapshot.modelKey}
				thinkingLevel={snapshot.thinkingLevel}
				thinkingLevels={snapshot.thinkingLevels}
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
