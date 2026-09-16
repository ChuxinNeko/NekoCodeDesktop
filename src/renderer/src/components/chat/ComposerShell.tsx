import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { ComposerSendArrowIcon, StopIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import {
	COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
	COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
	COMPOSER_EDITOR_PADDING_CLASS_NAME,
	COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
	COMPOSER_FOOTER_ROW_CLASS_NAME,
	COMPOSER_INPUT_SHELL_CLASS_NAME,
	COMPOSER_INPUT_SURFACE_CLASS_NAME,
	COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
} from "./composerPickerStyles";

interface ComposerShellProps {
	disabled: boolean;
	streaming?: boolean;
	placeholder?: string;
	autoFocus?: boolean;
	onSend: (text: string) => void;
	onAbort?: () => void;
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
	const { disabled, streaming } = props;
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

	return (
		<div className="px-[var(--app-density-chat-gutter-x,0.75rem)] pb-3 pt-1 sm:px-[var(--app-density-chat-gutter-x-lg,1.25rem)]">
			<ComposerColumnFrame>
				<div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
					<div className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
						<div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
							<textarea
								autoFocus={props.autoFocus}
								ref={textareaRef}
								value={text}
								onChange={(event) => setText(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										submit();
									}
								}}
								placeholder={props.placeholder ?? t("composer.placeholder")}
								rows={1}
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
						<div className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-1 pb-1.5 pr-1.5")}>
							<div className="flex min-w-0 items-center gap-1">{props.toolbar}</div>

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
