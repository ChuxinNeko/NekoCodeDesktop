import { useEffect, useRef, useState } from "react";
import type { ExecutionMode, ModelOption, ThinkingLevel } from "../../../shared/agent";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { ComposerColumnFrame } from "./chat/ComposerColumnFrame";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
	COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
	COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
	COMPOSER_EDITOR_PADDING_CLASS_NAME,
	COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
	COMPOSER_FOOTER_ROW_CLASS_NAME,
	COMPOSER_INPUT_SHELL_CLASS_NAME,
	COMPOSER_INPUT_SURFACE_CLASS_NAME,
	COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
	COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
	COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
} from "./chat/composerPickerStyles";
import {
	BrainIcon,
	ChevronDownIcon,
	ComposerSendArrowIcon,
	StopIcon,
	ZapIcon,
} from "../lib/icons";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MODE_LABELS: Record<ExecutionMode, string> = {
	"read-only": "Read only",
	auto: "Auto",
	"full-access": "Full access",
};

interface ComposerProps {
	disabled: boolean;
	streaming: boolean;
	models: ModelOption[];
	modelKey: string | null;
	thinkingLevel: ThinkingLevel;
	mode: ExecutionMode;
	onSend: (text: string) => void;
	onAbort: () => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
}

export function Composer(props: ComposerProps) {
	const { disabled, streaming, models, modelKey, thinkingLevel, mode } = props;
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${String(Math.min(el.scrollHeight, 320))}px`;
	}, [text]);

	const submit = () => {
		const value = text.trim();
		if (!value || disabled) return;
		setText("");
		props.onSend(value);
	};

	const modelLabel = models.find((option) => option.key === modelKey)?.name ?? "No model";

	const trigger = (label: string, icon: React.ReactNode, active = false) => (
		<Button
			className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
			size="chip"
			variant="ghost"
		>
			{icon}
			<span className={cn("truncate", active ? undefined : "text-[var(--color-text-foreground-secondary)]")}>
				{label}
			</span>
			<ChevronDownIcon className="size-3 opacity-60" />
		</Button>
	);

	return (
		<div className="px-[var(--app-density-chat-gutter-x,0.75rem)] pb-3 pt-1 sm:px-[var(--app-density-chat-gutter-x-lg,1.25rem)]">
			<ComposerColumnFrame>
				<div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
					<div className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
						<div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
							<textarea
								ref={textareaRef}
								value={text}
								onChange={(event) => setText(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										submit();
									}
								}}
								placeholder="Ask NekoCode to build, fix, or explain something…"
								rows={1}
								className={cn(
									"block w-full resize-none bg-transparent outline-none",
									COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
									COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
									COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
									COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME.replace("text-muted-foreground/40", "placeholder:text-muted-foreground/40"),
								)}
							/>
						</div>
						<div className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-1 pb-1.5 pr-1.5")}>
							<div className="flex min-w-0 items-center gap-1">
								<Menu>
									<MenuTrigger render={trigger(modelLabel, <ZapIcon className="size-3.5" />)} />
									<ComposerPickerMenuPopup align="start" side="top" fixedWidth>
										<MenuGroupLabel>Model</MenuGroupLabel>
										<MenuRadioGroup
											value={modelKey ?? ""}
											onValueChange={(value) => props.onSetModel(value)}
										>
											{models.length === 0 ? (
												<MenuItem className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME} disabled>
													No models configured
												</MenuItem>
											) : (
												models.map((option) => (
													<MenuRadioItem
														key={option.key}
														className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
														value={option.key}
													>
														<span className="truncate">{option.name}</span>
														<span className="ml-auto truncate text-muted-foreground/60">
															{option.provider}
														</span>
													</MenuRadioItem>
												))
											)}
										</MenuRadioGroup>
									</ComposerPickerMenuPopup>
								</Menu>

								<Menu>
									<MenuTrigger
										render={trigger(thinkingLevel, <BrainIcon className="size-3.5" />, thinkingLevel !== "off")}
									/>
									<ComposerPickerMenuPopup align="start" side="top">
										<MenuGroupLabel>Thinking</MenuGroupLabel>
										<MenuRadioGroup
											value={thinkingLevel}
											onValueChange={(value) => props.onSetThinking(value as ThinkingLevel)}
										>
											{THINKING_LEVELS.map((level) => (
												<MenuRadioItem
													key={level}
													className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
													value={level}
												>
													{level}
												</MenuRadioItem>
											))}
										</MenuRadioGroup>
									</ComposerPickerMenuPopup>
								</Menu>

								<Menu>
									<MenuTrigger render={trigger(MODE_LABELS[mode], null, mode !== "auto")} />
									<ComposerPickerMenuPopup align="start" side="top">
										<MenuGroupLabel>Mode</MenuGroupLabel>
										<MenuRadioGroup
											value={mode}
											onValueChange={(value) => props.onSetMode(value as ExecutionMode)}
										>
											{(["read-only", "auto", "full-access"] as ExecutionMode[]).map((entry) => (
												<MenuRadioItem
													key={entry}
													className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
													value={entry}
												>
													{MODE_LABELS[entry]}
												</MenuRadioItem>
											))}
										</MenuRadioGroup>
										<MenuSeparator />
										<MenuItem
											className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
											onClick={() => props.onSend("/help")}
										>
											Slash commands…
										</MenuItem>
									</ComposerPickerMenuPopup>
								</Menu>
							</div>

							{streaming ? (
								<Button
									aria-label="Stop"
									onClick={props.onAbort}
									size="icon-sm"
									variant="outline"
								>
									<StopIcon className="size-3.5" />
								</Button>
							) : (
								<Button
									aria-label="Send"
									disabled={disabled || text.trim().length === 0}
									onClick={submit}
									size="icon-sm"
									variant="prominent"
								>
									<ComposerSendArrowIcon className="size-3.5" />
								</Button>
							)}
						</div>
					</div>
				</div>
			</ComposerColumnFrame>
		</div>
	);
}
