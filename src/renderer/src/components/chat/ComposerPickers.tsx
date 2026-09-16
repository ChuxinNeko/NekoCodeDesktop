import type { ExecutionMode, ModelOption, ThinkingLevel } from "../../../../shared/agent";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { BrainIcon, ChevronDownIcon, ZapIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import {
	Menu,
	MenuGroupLabel,
	MenuItem,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import {
	COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
	COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
} from "./composerPickerStyles";

const MODE_LABEL_KEYS: Record<ExecutionMode, TranslationKey> = {
	"read-only": "mode.read-only",
	auto: "mode.auto",
	"full-access": "mode.full-access",
};

interface ComposerPickersProps {
	models: ModelOption[];
	modelKey: string | null;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	/** Shows the "Slash commands…" entry in the mode menu (open sessions only). */
	onSlashCommands?: () => void;
}

/**
 * The model / thinking / mode menus in the composer's toolbar, shared by the
 * open-session composer and the welcome screen — the pickers look and behave
 * the same whether or not a session exists yet.
 */
export function ComposerPickers(props: ComposerPickersProps) {
	const { t } = useTranslation();
	const { models, modelKey, thinkingLevel, thinkingLevels, mode } = props;
	// A model with nothing but "off" cannot think at all; say so instead of
	// offering a menu whose every entry would snap back.
	const thinkingSupported = thinkingLevels.length > 1;

	const modelLabel = models.find((option) => option.key === modelKey)?.name ?? t("picker.noModel");

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
		<>
			<Menu>
				<MenuTrigger render={trigger(modelLabel, <ZapIcon className="size-3.5" />)} />
				<ComposerPickerMenuPopup align="start" side="top" fixedWidth>
					{/* The label belongs inside the radio group: Base UI takes the group
					    context from MenuRadioGroup, and a label outside one throws as
					    soon as the menu opens. */}
					<MenuRadioGroup
						value={modelKey ?? ""}
						onValueChange={(value) => props.onSetModel(value)}
					>
						<MenuGroupLabel>{t("picker.model")}</MenuGroupLabel>
						{models.length === 0 ? (
							<MenuItem className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME} disabled>
								{t("picker.noModels")}
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

			{thinkingSupported ? (
				<Menu>
					<MenuTrigger
						render={trigger(thinkingLevel, <BrainIcon className="size-3.5" />, thinkingLevel !== "off")}
					/>
					<ComposerPickerMenuPopup align="start" side="top">
						<MenuRadioGroup
							value={thinkingLevel}
							onValueChange={(value) => props.onSetThinking(value as ThinkingLevel)}
						>
							<MenuGroupLabel>{t("picker.thinking")}</MenuGroupLabel>
							{thinkingLevels.map((level) => (
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
			) : (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								className={cn(
									COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
									"border-transparent",
								)}
								disabled
								size="chip"
								variant="ghost"
							/>
						}
					>
						<BrainIcon className="size-3.5" />
						<span className="truncate text-[var(--color-text-foreground-secondary)]">off</span>
					</TooltipTrigger>
					<TooltipPopup side="top">{t("picker.thinkingUnsupported")}</TooltipPopup>
				</Tooltip>
			)}

			<Menu>
				<MenuTrigger render={trigger(t(MODE_LABEL_KEYS[mode]), null, mode !== "auto")} />
				<ComposerPickerMenuPopup align="start" side="top">
					<MenuRadioGroup
						value={mode}
						onValueChange={(value) => props.onSetMode(value as ExecutionMode)}
					>
						<MenuGroupLabel>{t("picker.mode")}</MenuGroupLabel>
						{(["read-only", "auto", "full-access"] as ExecutionMode[]).map((entry) => (
							<MenuRadioItem
								key={entry}
								className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
								value={entry}
							>
								{t(MODE_LABEL_KEYS[entry])}
							</MenuRadioItem>
						))}
					</MenuRadioGroup>
					{props.onSlashCommands ? (
						<>
							<MenuSeparator />
							<MenuItem
								className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
								onClick={props.onSlashCommands}
							>
								{t("picker.slashCommands")}
							</MenuItem>
						</>
					) : null}
				</ComposerPickerMenuPopup>
			</Menu>
		</>
	);
}
