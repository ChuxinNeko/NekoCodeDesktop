import type { ComposerInsertion } from "../../../../shared/browser";
import type { SlashCommandSummary } from "../../../../shared/commands";
import { BorderBeam } from "border-beam";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { BackgroundTrayIcon, ComposerSendArrowIcon, FileIcon, SkillCubeIcon, StopIcon, XIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerCommandMenu, filterCommands } from "./ComposerCommandMenu";
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

/** Breathing room between the pill and the text that continues after it. */
const PILL_GAP_PX = 6;

interface ComposerShellProps {
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	disabled: boolean;
	streaming?: boolean;
	placeholder?: string;
	autoFocus?: boolean;
	onSend: (text: string) => void;
	/**
	 * Run the draft as a task in a session of its own, leaving this one on
	 * screen. Absent where there is nothing to stay on — the welcome screen has
	 * no open session, so every prompt there is the foreground one.
	 */
	onSendBackground?: (text: string) => void;
	onAbort?: () => void;
	/**
	 * Skills and prompt templates for the slash menu. Absent on surfaces with no
	 * session behind them — the welcome screen has no working directory yet, so
	 * there is nothing loaded to offer.
	 */
	loadCommands?: () => Promise<SlashCommandSummary[]>;
	/** Opens the slash menu from outside, e.g. the toolbar's "Slash commands…". */
	openCommandsSignal?: number;
	/**
	 * Left side of the footer row: the session pickers in a running session, the
	 * working-directory chip on the welcome screen.
	 */
	toolbar?: React.ReactNode;
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

	const matches = query === null ? [] : filterCommands(commands, query);
	const menuOpen = query !== null;

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

	const changeText = (next: string) => {
		setText(next);
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

	// A command with no arguments is a complete message — several skills take none.
	const sendable = command !== null || text.trim().length > 0;

	/**
	 * Hand the draft off and clear the box.
	 *
	 * `background` routes it to a new session instead of this one; the composer
	 * is emptied either way, because in both cases the draft is gone from here.
	 */
	const submit = (background = false) => {
		if (!sendable || disabled) return;
		const send = background ? props.onSendBackground : props.onSend;
		if (!send) return;
		const value = composed();
		setText("");
		setCommand(null);
		closeMenu();
		send(value);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

	const CommandIcon = command?.kind === "skill" ? SkillCubeIcon : FileIcon;

	return (
		<div className="px-[var(--app-density-chat-gutter-x,0.75rem)] pb-3 pt-1 sm:px-[var(--app-density-chat-gutter-x-lg,1.25rem)]">
			<ComposerColumnFrame>
				<div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
					{menuOpen ? (
						<ComposerCommandMenu
							commands={matches}
							activeIndex={activeIndex}
							onHighlight={setActiveIndex}
							onPick={pick}
						/>
					) : null}
					<BorderBeam active={streaming === true} theme={resolvedTheme} duration={6}>
						<div className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
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
										onChange={(event) => changeText(event.target.value)}
										onBlur={closeMenu}
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
								<div data-slot="composer-toolbar" className="flex min-w-0 flex-1 items-center gap-1">{props.toolbar}</div>

								{/* Stays put while the session streams: firing off a second task
								    without waiting for this one is the whole point of it. */}
								{props.onSendBackground ? (
									<Button
										aria-label={t("composer.sendBackground")}
										disabled={disabled || !sendable}
										onClick={() => submit(true)}
										size="icon-sm"
										title={t("composer.sendBackgroundHint")}
										variant="outline"
									>
										<BackgroundTrayIcon className="size-3.5" />
									</Button>
								) : null}

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
										disabled={disabled || !sendable}
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
