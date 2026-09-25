import type { ContextUsage, PromptImageAttachment, SendPromptRequest } from "../../../../shared/agent";
import {
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGE_TOTAL_BYTES,
	MAX_PROMPT_IMAGES,
} from "../../../../shared/agent";
import type { ComposerInsertion } from "../../../../shared/browser";
import type { SlashCommandSummary } from "../../../../shared/commands";
import {
	activeMention,
	mentionToken,
	SYMBOL_QUERY_PREFIX,
	type MentionCandidate,
} from "../../../../shared/mentions";
import { BorderBeam } from "border-beam";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { AddPlusIcon, ComposerSendArrowIcon, FileIcon, SkillCubeIcon, StopIcon, XIcon, ZapIcon } from "../../lib/icons";
import { fileToPromptImage, imageMimeType } from "./composer-images";
import { ContextGauge } from "./ContextGauge";
import { Button } from "../ui/button";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerCommandMenu, filterCommands } from "./ComposerCommandMenu";
import { ComposerMentionMenu } from "./ComposerMentionMenu";
import {
	COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
	COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
	COMPOSER_EDITOR_PADDING_CLASS_NAME,
	COMPOSER_EDITOR_TEXT_CLASS_NAME,
	COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
	COMPOSER_FOOTER_ROW_CLASS_NAME,
	COMPOSER_INPUT_SHELL_CLASS_NAME,
	COMPOSER_INPUT_SURFACE_CLASS_NAME,
	COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
} from "./composerPickerStyles";

/**
 * A message that starts with a slash and has no whitespace yet is still being
 * spelled out, so the menu stays open and filters on what follows. The moment a
 * space is typed the name is settled and the menu gets out of the way.
 */
const PENDING_COMMAND = /^\/(\S*)$/;

/** How long typing pauses before the `@` list is asked for again. */
const MENTION_DEBOUNCE_MS = 80;

/** Breathing room between the pill and the text that continues after it. */
const PILL_GAP_PX = 6;

interface ComposerShellProps {
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	disabled: boolean;
	streaming?: boolean;
	placeholder?: string;
	autoFocus?: boolean;
	onSend: (request: SendPromptRequest) => void;
	supportsImages?: boolean;
	allowImageAttachments?: boolean;
	/**
	 * Run the draft as a task in a session of its own, leaving this one on
	 * screen. Absent where there is nothing to stay on — the welcome screen has
	 * no open session, so every prompt there is the foreground one.
	 */
	/** Ctrl/Cmd+Enter routes the draft here instead — a task of its own. */
	onSendBackground?: (text: string) => void;
	/** Drawn beside send when the session has reported context usage. */
	context?: ContextUsage;
	onAbort?: () => void;
	/**
	 * Skills and prompt templates for the slash menu. Absent on surfaces with no
	 * session behind them — the welcome screen has no working directory yet, so
	 * there is nothing loaded to offer.
	 */
	loadCommands?: () => Promise<SlashCommandSummary[]>;
	/**
	 * Candidates for an `@` reference. Absent where nothing would expand one —
	 * an external agent's session gets the text as typed.
	 */
	loadMentions?: (query: string) => Promise<MentionCandidate[]>;
	/** Opens the slash menu from outside, e.g. the toolbar's "Slash commands…". */
	openCommandsSignal?: number;
	/**
	 * Left side of the footer row: the session pickers in a running session, the
	 * working-directory chip on the welcome screen.
	 */
	toolbar?: React.ReactNode;
	/** Above the input, in the same column: the workspace picker. */
	header?: React.ReactNode;
}

/**
 * The composer's input surface, shared by the welcome screen and an open session
 * so the field sits in exactly the same place before and after a session starts —
 * sending the first prompt must not make the box jump.
 */
export function ComposerShell(props: ComposerShellProps) {
	const { t } = useTranslation();
	const { resolvedTheme } = useTheme();
	const { disabled, streaming } = props;
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	/**
	 * An accepted command, held apart from the text.
	 *
	 * The agent core only expands a slash command when it is the very first
	 * character of the message, so keeping it out of the editable text is what
	 * makes it impossible to type ahead of it and silently break the expansion.
	 * It is also what the pill renders from.
	 */
	const [command, setCommand] = useState<SlashCommandSummary | null>(null);
	const [commands, setCommands] = useState<readonly SlashCommandSummary[]>([]);
	const [query, setQuery] = useState<string | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);

	const [images, setImages] = useState<{ id: string; attachment: PromptImageAttachment; bytes: number }[]>([]);
	const [imageError, setImageError] = useState<string | null>(null);
	const [dragActive, setDragActive] = useState(false);
	const dragDepth = useRef(0);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imagesAllowed = props.allowImageAttachments !== false;
	const imageCapable = imagesAllowed && props.supportsImages === true && !disabled;

	const matches = query === null ? [] : filterCommands(commands, query);
	const menuOpen = query !== null;

	/** The `@query` being typed at the caret, and what it currently offers. */
	const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
	const [mentionResults, setMentionResults] = useState<{ query: string; candidates: MentionCandidate[] } | null>(null);
	const [mentionIndex, setMentionIndex] = useState(0);
	const mentionOpen = mention !== null && !menuOpen;
	const mentionCandidates =
		mentionResults && mention && mentionResults.query === mention.query ? mentionResults.candidates : [];
	const mentionSeq = useRef(0);
	// Through a ref: callers pass a fresh closure every render, and a streaming
	// session renders many times a second — as a dependency it would restart the
	// debounce forever and the list would never load.
	const loadMentions = useRef(props.loadMentions);
	loadMentions.current = props.loadMentions;
	useEffect(() => {
		const load = loadMentions.current;
		if (!mention || !load) return;
		const seq = ++mentionSeq.current;
		const wanted = mention.query;
		const timer = setTimeout(() => {
			load(wanted)
				.then((candidates) => {
					// Only the newest query's answer: a slow search for "a" must not
					// land on top of the one for "ab".
					if (seq !== mentionSeq.current) return;
					setMentionResults({ query: wanted, candidates });
					setMentionIndex(0);
				})
				.catch(() => {
					if (seq === mentionSeq.current) setMentionResults({ query: wanted, candidates: [] });
				});
		}, MENTION_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [mention?.query, mention?.start]);

	/** Re-read the `@` at the caret after the text or the caret moved. */
	/**
	 * The text as it is about to render. React fires onSelect in the same
	 * dispatch as the keydown that picked a reference — before the new text has
	 * reached the textarea — and reading the old value there would reopen the
	 * menu the pick just closed.
	 */
	const pendingText = useRef(text);
	pendingText.current = text;
	const syncMention = (value: string, caret: number | null) => {
		if (value !== pendingText.current) return;
		if (!props.loadMentions || caret === null) {
			setMention(null);
			return;
		}
		const next = activeMention(value, caret);
		setMention((current) =>
			current && next && current.start === next.start && current.query === next.query ? current : next,
		);
	};

	/** Swap the `@query` being typed for the picked reference, caret after it. */
	const pickMention = (candidate: MentionCandidate) => {
		if (!mention) return;
		const token = `${mentionToken(candidate)} `;
		const end = mention.start + 1 + mention.query.length;
		const next = text.slice(0, mention.start) + token + text.slice(end).replace(/^ /, "");
		const caret = mention.start + token.length;
		pendingText.current = next;
		setText(next);
		setMention(null);
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(caret, caret);
		});
	};

	/**
	 * How far the first line is pushed right to clear the pill.
	 *
	 * Measured rather than estimated: the label is a command name of any length
	 * in a font that may still be loading, and a guess that came up short would
	 * put typed text underneath the pill.
	 */
	const pillRef = useRef<HTMLSpanElement | null>(null);
	const [indent, setIndent] = useState(0);
	useLayoutEffect(() => {
		const el = pillRef.current;
		if (!command || !el) {
			setIndent(0);
			return;
		}
		const measure = () => setIndent(Math.ceil(el.getBoundingClientRect().width) + PILL_GAP_PX);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [command]);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${String(Math.min(el.scrollHeight, 320))}px`;
	}, [text, indent]);

	const consumedInsertion = useRef<string | null>(null);
	useEffect(() => {
		if (!props.insertion || consumedInsertion.current === props.insertion.id) return;
		consumedInsertion.current = props.insertion.id;
		const insertion = props.insertion;
		setText((draft) => draft + (draft && !draft.endsWith("\n") ? "\n" : "") + insertion.text);
		props.onInsertionConsumed?.(insertion.id);
		textareaRef.current?.focus();
	}, [props.insertion, props.onInsertionConsumed]);

	/**
	 * Open the menu and refresh the list.
	 *
	 * Fetched on every open rather than cached: a skill file can be added or
	 * switched off in settings while the composer sits untouched, and a stale
	 * list would offer a command the session can no longer expand.
	 */
	const openMenu = (nextQuery: string) => {
		// No loader means no session behind this composer — the welcome screen has
		// no working directory yet, so a slash there is just a character.
		const load = props.loadCommands;
		if (!load) return;
		setQuery(nextQuery);
		setActiveIndex(0);
		void load().then(setCommands).catch(() => setCommands([]));
	};

	const closeMenu = () => setQuery(null);

	// The toolbar's entry point. A counter rather than a boolean so reopening
	// after a dismiss still fires; the ref is seeded with the mount value so the
	// first render does not count as a request to open.
	const consumedOpenSignal = useRef<number | undefined>(props.openCommandsSignal);
	useEffect(() => {
		if (props.openCommandsSignal === undefined) return;
		if (consumedOpenSignal.current === props.openCommandsSignal) return;
		consumedOpenSignal.current = props.openCommandsSignal;
		// Asking for the menu means starting a command, so the composer is reset
		// to the state typing a bare slash would have put it in — only one command
		// can lead a message, and a half-written one would have to go anyway.
		setCommand(null);
		setText("");
		openMenu("");
		textareaRef.current?.focus();
	}, [props.openCommandsSignal]);

	const changeText = (next: string, caret: number | null = null) => {
		pendingText.current = next;
		setText(next);
		syncMention(next, caret);
		// A command already accepted owns the leading slash, so what is typed now
		// is its arguments — a slash in there is just a character.
		if (command) return;
		const pending = PENDING_COMMAND.exec(next);
		if (pending) openMenu(pending[1]);
		else closeMenu();
	};

	const pick = (picked: SlashCommandSummary) => {
		setCommand(picked);
		setText("");
		closeMenu();
		textareaRef.current?.focus();
	};

	const clearCommand = () => {
		setCommand(null);
		textareaRef.current?.focus();
	};

	/** What actually gets sent: the pill's command, then whatever was typed. */
	const composed = () => {
		const body = text.trim();
		if (!command) return body;
		return body ? `/${command.name} ${body}` : `/${command.name}`;
	};

	const addFiles = async (files: readonly File[]) => {
		if (!imagesAllowed || disabled || files.length === 0) return;
		if (props.supportsImages !== true) {
			setImageError(t("composer.imagesUnsupportedModel"));
			return;
		}
		const accepted = [...images];
		let total = accepted.reduce((sum, image) => sum + image.bytes, 0);
		let failed: string | null = null;
		for (const file of files) {
			if (accepted.length >= MAX_PROMPT_IMAGES) {
				failed = t("composer.imagesTooMany", { max: MAX_PROMPT_IMAGES });
				break;
			}
			if (!imageMimeType(file)) {
				failed = t("composer.imageUnsupportedType");
				continue;
			}
			if (file.size > MAX_PROMPT_IMAGE_BYTES) {
				failed = t("composer.imageTooLarge", { max: MAX_PROMPT_IMAGE_BYTES / 1024 / 1024 });
				continue;
			}
			if (total + file.size > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
				failed = t("composer.imagesTotalTooLarge", { max: MAX_PROMPT_IMAGE_TOTAL_BYTES / 1024 / 1024 });
				continue;
			}
			try {
				const attachment = await fileToPromptImage(file);
				accepted.push({ id: crypto.randomUUID(), attachment, bytes: file.size });
				total += file.size;
			} catch {
				failed = t("composer.imageUnsupportedType");
			}
		}
		setImages(accepted);
		setImageError(failed);
	};

	const removeImage = (id: string) => {
		setImages((current) => current.filter((image) => image.id !== id));
		setImageError(null);
	};

	const isFileDrag = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");

	const onDragEnter = (event: React.DragEvent) => {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		dragDepth.current += 1;
		if (imageCapable) setDragActive(true);
	};
	const onDragOver = (event: React.DragEvent) => {
		if (!isFileDrag(event)) return;
		event.preventDefault();
	};
	const onDragLeave = (event: React.DragEvent) => {
		if (!isFileDrag(event)) return;
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDragActive(false);
	};
	const onDrop = (event: React.DragEvent) => {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		dragDepth.current = 0;
		setDragActive(false);
		const files = [...event.dataTransfer.files];
		if (!imagesAllowed) return;
		void addFiles(files);
	};

	// A command with no arguments is a complete message — several skills take none.
	const sendable = command !== null || text.trim().length > 0 || images.length > 0;
	const imagesBlocked = images.length > 0 && props.supportsImages !== true;
	const shownImageError = imageError ?? (imagesBlocked ? t("composer.imagesUnsupportedModel") : null);

	/**
	 * Hand the draft off and clear the box.
	 *
	 * `background` routes it to a new session instead of this one; the composer
	 * is emptied either way, because in both cases the draft is gone from here.
	 */
	const submit = (background = false) => {
		if (!sendable || disabled || imagesBlocked) return;
		const value = composed();
		if (background && images.length === 0) {
			if (!props.onSendBackground) return;
			setText("");
			setCommand(null);
			setImages([]);
			setImageError(null);
			closeMenu();
			props.onSendBackground(value);
			return;
		}
		const request: SendPromptRequest = {
			text: value || t("composer.imageOnlyPrompt"),
			...(images.length ? { images: images.map((image) => image.attachment) } : {}),
		};
		setText("");
		setCommand(null);
		setImages([]);
		setImageError(null);
		closeMenu();
		setMention(null);
		props.onSend(request);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (mentionOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (mentionCandidates.length === 0) return;
				const step = event.key === "ArrowDown" ? 1 : -1;
				setMentionIndex((index) => (index + step + mentionCandidates.length) % mentionCandidates.length);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setMention(null);
				return;
			}
			if ((event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) || event.key === "Tab") {
				const picked = mentionCandidates[mentionIndex];
				if (picked) {
					event.preventDefault();
					pickMention(picked);
					return;
				}
				// Nothing to pick yet: Tab stays put, Enter sends what is there.
				if (event.key === "Tab") {
					event.preventDefault();
					return;
				}
			}
		}
		if (menuOpen) {

			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (matches.length === 0) return;
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActiveIndex((index) => (index + step + matches.length) % matches.length);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				closeMenu();
				return;
			}
			// Tab commits without any chance of sending; Enter commits too, because
			// with the menu open it is a pick, not a submit.
			if (
				(event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) ||
				event.key === "Tab"
			) {
				const picked = matches[activeIndex];
				if (picked) {
					event.preventDefault();
					pick(picked);
					return;
				}
				if (event.key === "Tab") return;
			}
		}
		// Backspace into the pill removes it, the way a chip in any tag field does.
		if (
			event.key === "Backspace" &&
			command &&
			text.length === 0 &&
			event.currentTarget.selectionStart === 0 &&
			event.currentTarget.selectionEnd === 0
		) {
			event.preventDefault();
			clearCommand();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			// Held modifier: the prompt goes to a new task rather than to this one.
			submit(event.ctrlKey || event.metaKey);
		}
	};

	const CommandIcon = command?.kind === "skill" ? SkillCubeIcon : command?.kind === "builtin" ? ZapIcon : FileIcon;

	return (
		<div className="px-[var(--app-density-chat-gutter-x,0.75rem)] pb-3 pt-1 sm:px-[var(--app-density-chat-gutter-x-lg,1.25rem)]">
			<ComposerColumnFrame>
				{props.header}
				<div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
					{mentionOpen ? (
						<ComposerMentionMenu
							candidates={mentionCandidates}
							loading={mentionResults?.query !== mention.query}
							symbols={mention.query.startsWith(SYMBOL_QUERY_PREFIX)}
							activeIndex={mentionIndex}
							onHighlight={setMentionIndex}
							onPick={pickMention}
						/>
					) : null}
					{menuOpen ? (
						<ComposerCommandMenu
							commands={matches}
							activeIndex={activeIndex}
							onHighlight={setActiveIndex}
							onPick={pick}
						/>
					) : null}
					<BorderBeam active={streaming === true} theme={resolvedTheme} duration={6}>
						<div
							className={cn(
								COMPOSER_INPUT_SURFACE_CLASS_NAME,
								dragActive && "border-[color:var(--color-border-focus)] bg-[color-mix(in_srgb,var(--color-border-focus)_6%,transparent)]",
							)}
							onDragEnter={onDragEnter}
							onDragOver={onDragOver}
							onDragLeave={onDragLeave}
							onDrop={onDrop}
						>
							{images.length > 0 ? (
								<div className="flex flex-wrap gap-2 px-3 pt-2">
									{images.map((image) => (
										<div
											key={image.id}
											className="flex items-center gap-1.5 rounded-lg border border-[color:var(--surface-border)] bg-[var(--color-background-elevated-secondary)] p-1"
										>
											<img
												src={`data:${image.attachment.mimeType};base64,${image.attachment.data}`}
												alt={image.attachment.name}
												className="size-10 shrink-0 rounded-md object-cover"
											/>
											<span className="max-w-24 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
												{image.attachment.name}
											</span>
											<button
												type="button"
												aria-label={t("composer.removeImage")}
												onClick={() => removeImage(image.id)}
												className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
											>
												<XIcon className="size-2.5" />
											</button>
										</div>
									))}
								</div>
							) : null}
							{shownImageError ? (
								<div className="px-3 pt-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
									{shownImageError}
								</div>
							) : null}
							<div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
								{/* The pill sits *in* the first line rather than above it: a
								    textarea cannot hold an element, so it is laid over the
								    line box and the text is pushed past it with text-indent,
								    which by definition only affects the first line. */}
								<div className="relative">
									{command ? (
										<span
											className={cn(
												"pointer-events-none absolute left-0 top-0 flex h-[1.625em] max-w-[70%] items-center",
												COMPOSER_EDITOR_TEXT_CLASS_NAME,
											)}
										>
											<span
												ref={pillRef}
												className="pointer-events-auto inline-flex min-w-0 items-center gap-1 rounded-full bg-[var(--color-background-button-secondary)] pl-1.5 pr-0.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-[1.35] text-[var(--color-text-foreground)]"
											>
												<CommandIcon className="size-3 shrink-0 opacity-70" />
												<span className="truncate font-mono">/{command.name}</span>
												<button
													type="button"
													aria-label={t("commands.remove")}
													onClick={clearCommand}
													className="flex size-3.5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
												>
													<XIcon className="size-2.5" />
												</button>
											</span>
										</span>
									) : null}
									<textarea
										autoFocus={props.autoFocus}
										ref={textareaRef}
										value={text}
										onChange={(event) => changeText(event.target.value, event.target.selectionStart)}
										onSelect={(event) =>
											syncMention(event.currentTarget.value, event.currentTarget.selectionStart)
										}
										onBlur={() => {
											closeMenu();
											setMention(null);
										}}
										onKeyDown={onKeyDown}
										placeholder={
											command
												? (command.argumentHint ?? t("commands.argsPlaceholder"))
												: (props.placeholder ?? t("composer.placeholder"))
										}
										rows={1}
										style={command ? { textIndent: `${String(indent)}px` } : undefined}
										className={cn(
											"block w-full resize-none bg-transparent outline-none",
											COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
											COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
											COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
											COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME.replace(
												"text-muted-foreground/40",
												"placeholder:text-muted-foreground/40",
											),
										)}
									/>
								</div>
							</div>
							<div data-slot="composer-footer" className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-1 pb-1.5 pr-1.5")}>
								{imagesAllowed ? (
									<Button
										aria-label={t("composer.addImage")}
										title={props.supportsImages === true ? t("composer.addImage") : t("composer.imagesUnsupportedModel")}
										disabled={disabled || props.supportsImages !== true}
										onClick={() => fileInputRef.current?.click()}
										size="icon-sm"
										variant="outline"
									>
										<AddPlusIcon className="size-3.5" />
									</Button>
								) : null}
								<input
									ref={fileInputRef}
									type="file"
									accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
									multiple
									className="hidden"
									onChange={(event) => {
										const files = [...(event.target.files ?? [])];
										event.target.value = "";
										void addFiles(files);
									}}
								/>
								<div data-slot="composer-toolbar" className="flex min-w-0 flex-1 items-center gap-1">{props.toolbar}</div>

								{/* Sits next to send because that is where the eye already is at
								    the moment the length of the conversation starts to matter. */}
								{props.context ? <ContextGauge context={props.context} /> : null}

								{streaming && props.onAbort ? (
									<Button
										aria-label={t("composer.stop")}
										onClick={props.onAbort}
										size="icon-sm"
										variant="outline"
									>
										<StopIcon className="size-3.5" />
									</Button>
								) : (
									<Button
										aria-label={t("composer.send")}
										disabled={disabled || !sendable || imagesBlocked}
										onClick={() => submit()}
										size="icon-sm"
										variant="prominent"
									>
										<ComposerSendArrowIcon className="size-3.5" />
									</Button>
								)}
							</div>
						</div>
					</BorderBeam>
				</div>
			</ComposerColumnFrame>
		</div>
	);
}
