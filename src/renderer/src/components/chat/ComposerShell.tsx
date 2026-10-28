import { useShortcuts } from "../../hooks/useShortcuts";
import { matchesShortcut } from "../../lib/shortcuts";
import { usePromptPrediction } from "../../hooks/usePromptPrediction";
import { canAcceptPrediction, type PredictionContext } from "../../lib/promptPrediction";
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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { AddPlusIcon, ComposerSendArrowIcon, FileIcon, PluginIcon, SkillCubeIcon, StopIcon, XIcon, ZapIcon } from "../../lib/icons";
import { fileToPromptImage, imageMimeType, namePastedImages, pastedImageFiles } from "./composer-images";
import { editShortcut, hasSelection, redoShortcut, runEditCommand } from "../../lib/editCommands";
import { ContextMenu, type ContextMenuState } from "../ui/context-menu";
import { ContextGauge } from "./ContextGauge";
import { Button } from "../ui/button";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerQueue } from "./ComposerQueue";
import { useComposerQueue } from "./useComposerQueue";
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
	/** Optional room-owned draft, retained across navigation and failed sends. */
	draft?: string;
	onDraftChange?: (text: string) => void;
	/** Some transports clear their controlled draft only after accepting a send. */
	clearOnSend?: boolean;
	/** Defaults to the capsule layout; only the welcome page opts into the original card. */
	followUp?: boolean;
	inlineToolbar?: React.ReactNode;
	workspacePicker?: React.ReactNode;
	predictionContext?: PredictionContext;
	/** Allows the welcome surface to place the shared composer in its hero card. */
	className?: string;
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	disabled: boolean;
	/** Keeps queued follow-ups with the conversation that received them. */
	queueScope?: string;
	streaming?: boolean;
	placeholder?: string;
	autoFocus?: boolean;
	onSend: (request: SendPromptRequest) => void | Promise<void>;
	onQueueSend?: (request: SendPromptRequest) => void | Promise<void>;
	onSteer?: (request: SendPromptRequest) => void | Promise<void>;
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
	/** Stacked immediately above the input, inside its width-constrained frame. */
	activity?: React.ReactNode;
}

/**
 * The composer's input surface, shared by the welcome screen and an open session
 * so the field sits in exactly the same place before and after a session starts —
 * sending the first prompt must not make the box jump.
 */
export function ComposerShell(props: ComposerShellProps) {
	const { bindings, label: shortcutLabel } = useShortcuts();
	const { t } = useTranslation();
	const { resolvedTheme } = useTheme();
	const { disabled, streaming } = props;
	const queue = useComposerQueue({
		scope: props.queueScope ?? "default",
		disabled,
		streaming: streaming === true,
		onSend: props.onQueueSend ?? props.onSend,
		onSteer: props.onSteer,
	});
	const followUp = props.followUp !== false;
	const [internalText, setInternalText] = useState("");
	const text = props.draft ?? internalText;
	const setText = (next: React.SetStateAction<string>) => {
		const value = typeof next === "function" ? next(text) : next;
		if (props.draft === undefined) setInternalText(value);
		props.onDraftChange?.(value);
	};
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

	const prediction = usePromptPrediction(props.predictionContext, streaming === true,
		disabled || !!text || !!command || images.length > 0 || menuOpen || !!props.insertion);

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
	}, [text, indent, followUp]);

	const consumedInsertion = useRef<string | null>(null);
	useEffect(() => {
		if (!props.insertion || consumedInsertion.current === props.insertion.id) return;
		consumedInsertion.current = props.insertion.id;
		const insertion = props.insertion;
		setText((draft) =>
			insertion.replace ? insertion.text : draft + (draft && !draft.endsWith("\n") ? "\n" : "") + insertion.text,
		);
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

	/**
	 * Ctrl+V and the menu's paste both land here (on the desktop the menu runs a
	 * native paste). Text pastes as usual; a clipboard of only images attaches them.
	 */
	const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		if (!imagesAllowed) return;
		const files = pastedImageFiles(event.clipboardData);
		if (files.length === 0) return;
		event.preventDefault();
		void addFiles(namePastedImages(files));
	};

	const [editMenu, setEditMenu] = useState<ContextMenuState | null>(null);
	const closeEditMenu = useCallback(() => setEditMenu(null), []);

	const onContextMenu = (event: React.MouseEvent<HTMLTextAreaElement>) => {
		event.preventDefault();
		const field = event.currentTarget;
		const selected = hasSelection(field);
		const run = (command: Parameters<typeof runEditCommand>[0]) => () => {
			void runEditCommand(command, field, (files) => void addFiles(namePastedImages(files))).catch(() => {});
		};
		setEditMenu({
			x: event.clientX,
			y: event.clientY,
			items: [
				{ label: t("editMenu.undo"), shortcut: editShortcut("Z"), disabled, onSelect: run("undo") },
				{ label: t("editMenu.redo"), shortcut: redoShortcut(), disabled, onSelect: run("redo") },
				{ kind: "separator" },
				{ label: t("editMenu.cut"), shortcut: editShortcut("X"), disabled: disabled || !selected, onSelect: run("cut") },
				{ label: t("editMenu.copy"), shortcut: editShortcut("C"), disabled: !selected, onSelect: run("copy") },
				{ label: t("editMenu.paste"), shortcut: editShortcut("V"), disabled, onSelect: run("paste") },
				{ kind: "separator" },
				{ label: t("editMenu.selectAll"), shortcut: editShortcut("A"), disabled: field.value.length === 0, onSelect: run("selectAll") },
			],
		});
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
		const queued = streaming === true;
		if (queued || props.clearOnSend !== false) setText("");
		setCommand(null);
		setImages([]);
		setImageError(null);
		closeMenu();
		setMention(null);
		if (queued) queue.enqueue(request);
		else props.onSend(request);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.repeat && (matchesShortcut(event.nativeEvent, bindings["composer.send"]) || matchesShortcut(event.nativeEvent, bindings["composer.background"]))) {
			event.preventDefault();
			return;
		}
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
		if (!menuOpen && !mentionOpen && prediction.text) {
			if (event.key === "Escape") { event.preventDefault(); prediction.dismiss(); return; }
			if (canAcceptPrediction(event.key, event.shiftKey, event.ctrlKey, event.altKey, event.metaKey, event.nativeEvent.isComposing)) {
				event.preventDefault();
				changeText(prediction.text);
				prediction.dismiss();
				return;
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
		if (matchesShortcut(event.nativeEvent, bindings["composer.background"])) {
			event.preventDefault();
			submit(true);
		} else if (matchesShortcut(event.nativeEvent, bindings["composer.send"])) {
			event.preventDefault();
			submit();
		}
	};

	const CommandIcon =
		command?.kind === "skill" ? SkillCubeIcon
		: command?.kind === "builtin" ? ZapIcon
		: command?.kind === "extension" ? PluginIcon
		: FileIcon;

	return (
		<div data-composer-layout={followUp ? "follow-up" : "welcome"} className={cn("px-[var(--app-density-chat-gutter-x,0.75rem)] pb-3 pt-0 sm:px-[var(--app-density-chat-gutter-x-lg,1.25rem)]", followUp && "follow-up-composer", props.className)}>
			<ComposerColumnFrame className="relative">
				{props.header ? (
					<div data-composer-floating-controls="" className="@container pointer-events-none absolute inset-x-0 bottom-full z-20 flex flex-wrap items-end justify-between gap-2 pb-2 [&>*]:pointer-events-auto">
						{props.header}
					</div>
				) : null}
				{props.activity}
				<ComposerQueue
					items={queue.items}
					streaming={streaming === true}
					canSteer={!!props.onSteer && !disabled}
					sendingId={queue.sendingId}
					error={queue.error}
					onSendNow={queue.sendNow}
					onRemove={queue.remove}
				/>
				<div className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, (mentionOpen || menuOpen) && "z-30")}>
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
					<BorderBeam active={streaming === true} theme={resolvedTheme} duration={6} borderRadius={followUp ? 28 : undefined}>
						<div
							data-composer-attachments={imagesAllowed ? "enabled" : "hidden"}
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
								<div data-slot="composer-images" className="flex flex-wrap gap-2 px-3 pt-2">
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
								<div data-slot="composer-image-error" className="px-3 pt-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
									{shownImageError}
								</div>
							) : null}
							<div data-slot="composer-editor" className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
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
									{prediction.text ? <div aria-hidden="true" data-prompt-prediction="" className={cn("pointer-events-none absolute inset-x-0 top-0 pr-12 text-muted-foreground/45", COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME)}>
										<span className="block truncate">{prediction.text}</span>
										<kbd className="absolute right-0 top-0 rounded border border-border/60 px-1 text-[10px] leading-5">Tab</kbd>
									</div> : null}

									<textarea
										autoFocus={props.autoFocus}
										ref={textareaRef}
									data-chat-composer
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
										onPaste={onPaste}
										onContextMenu={onContextMenu}
										placeholder={
											command
												? (command.argumentHint ?? t("commands.argsPlaceholder"))
												: (prediction.text ? "" : props.placeholder ?? t(followUp ? "composer.followUpPlaceholder" : "composer.placeholder"))
										}
										rows={1}
										aria-label={t("composer.placeholder")}
										aria-description={prediction.text ? t("codeIntel.prediction.acceptHint", { text: prediction.text }) : undefined}
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
										data-composer-control="attach"
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
								{followUp ? <div data-slot="composer-inline-toolbar">{props.inlineToolbar}</div> : <div data-slot="composer-toolbar" className="flex min-w-0 flex-1 items-center gap-1">{props.toolbar}</div>}

								{/* Sits next to send because that is where the eye already is at
								    the moment the length of the conversation starts to matter. */}
								{!followUp && props.context ? <ContextGauge context={props.context} /> : null}

								<div data-slot="composer-actions" className="flex shrink-0 items-center gap-1">
								{streaming ? (
									<Button
										data-composer-control="queue"
										aria-label={t("composer.queue")}
										title={[t("composer.queue"), shortcutLabel("composer.send")].filter(Boolean).join(" · ")}
										disabled={disabled || !sendable || imagesBlocked}
										onClick={() => submit()}
										size="icon-sm"
										variant="prominent"
									>
										<ComposerSendArrowIcon className="size-3.5" />
									</Button>
								) : null}
								{streaming && props.onAbort ? (
									<Button
										data-composer-control="stop"
										aria-label={t("composer.stop")}
										title={[t("composer.stop"), shortcutLabel("app.stop")].filter(Boolean).join(" · ")}
										onClick={props.onAbort}
										size="icon-sm"
										variant="outline"
									>
										<StopIcon className="size-3.5" />
									</Button>
								) : null}
								{!streaming ? (
									<Button
										data-composer-control="submit"
										aria-label={t("composer.send")}
										title={[t("composer.send"), shortcutLabel("composer.send")].filter(Boolean).join(" · ")}
										disabled={disabled || !sendable || imagesBlocked}
										onClick={() => submit()}
										size="icon-sm"
										variant="prominent"
									>
										<ComposerSendArrowIcon className="size-3.5" />
									</Button>
								) : null}
								</div>
							</div>
						</div>
					</BorderBeam>
				</div>
				{followUp ? <div data-slot="composer-meta" className="mt-2 flex min-w-0 items-center gap-2 px-1">
					<div data-slot="composer-toolbar" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{props.workspacePicker}{props.toolbar}</div>
					{props.context ? <ContextGauge context={props.context} /> : null}
				</div> : null}
			</ComposerColumnFrame>
			<ContextMenu menu={editMenu} onClose={closeEditMenu} />
		</div>
	);
}
