import { useState } from "react";
import type { FusionConfig } from "../../../../shared/fusion";
import { FusionPicker } from "./FusionPicker";
import {
	DEFAULT_AGENT_PHASE,
	WORK_MODES,
	type AgentPhase,
	type WorkMode,
} from "../../../../shared/workflow";
import {
	modelLabel,
	modelName,
	type ExecutionMode,
	type ModelOption,
	type ThinkingLevel,
} from "../../../../shared/agent";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { BrainIcon, ChevronDownIcon, ZapIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import {
	Menu,
	MenuGroup,
	MenuGroupLabel,
	MenuItem,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuSub,
	MenuSubTrigger,
	MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
	COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
	COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME,
	COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
} from "./composerPickerStyles";

const WORK_MODE_KEYS: Record<WorkMode, TranslationKey> = {
	agent: "workMode.agent",
	ask: "workMode.ask",
	plan: "workMode.plan",
	debug: "workMode.debug",
	multitask: "workMode.multitask",
};

const AGENT_PHASE_KEYS: Record<AgentPhase, TranslationKey> = {
	answer: "agentPhase.answer",
	plan: "agentPhase.plan",
	execute: "agentPhase.execute",
	debug: "agentPhase.debug",
	delegate: "agentPhase.delegate",
};

const MODE_LABEL_KEYS: Record<ExecutionMode, TranslationKey> = {
	"read-only": "mode.read-only",
	auto: "mode.auto",
	"full-access": "mode.full-access",
};

interface ComposerPickersProps {
	models: ModelOption[];
	modelKey: string | null;
	fusion?: FusionConfig | null;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
	workMode: WorkMode;
	/** Shown beside "Agent"; ignored by the manually pinned modes. */
	agentPhase: AgentPhase;
	disabled?: boolean;
	onSetFusion: (config: FusionConfig) => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	onSetWorkMode: (mode: WorkMode) => void;
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
	const [modelMenuOpen, setModelMenuOpen] = useState(false);

	const active = models.find((option) => option.key === modelKey);
	const providerGroups = Array.from(
		models.reduce((groups, model) => {
			const group = groups.get(model.provider);
			if (group) group.models.push(model);
			else groups.set(model.provider, {
				id: model.provider,
				name: model.providerName.trim() || model.provider,
				models: [model],
			});
			return groups;
		}, new Map<string, { id: string; name: string; models: ModelOption[] }>()),
		([, group]) => group,
	);
	const triggerLabel = props.fusion ? "Fusion" : active ? modelLabel(active) : t("picker.noModel");

	const trigger = (label: string, icon: React.ReactNode, active = false) => (
		<Button
			disabled={props.disabled}
			className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
			size="chip"
			variant="ghost"
		>
			{icon}
			<span
				className={cn(
					"truncate",
					active ? undefined : "text-[var(--color-text-foreground-secondary)]",
				)}
			>
				{label}
			</span>
			<ChevronDownIcon className="size-3 opacity-60" />
		</Button>
	);

	return (
		<>
			<Menu>
				<MenuTrigger
					disabled={props.disabled}
					render={trigger(t(MODE_LABEL_KEYS[mode]), null, mode !== "auto")}
				/>
				<ComposerPickerMenuPopup align="start" side="top">
					<MenuRadioGroup
						value={mode}
						onValueChange={(value) => props.onSetMode(value as ExecutionMode)}
					>
						<MenuGroupLabel>{t("picker.mode")}</MenuGroupLabel>
						{(["read-only", "auto", "full-access"] as ExecutionMode[]).map((entry) => (
							<MenuRadioItem
								key={entry}
								value={entry}
								className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
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

			<Menu>
				<MenuTrigger
					disabled={props.disabled}
					render={trigger(
						// Agent picks its own phase as it works, so the trigger reports the
						// discipline in force rather than just the mode the user pinned.
						props.workMode === "agent"
							? t("workMode.agent") + " · " + t(AGENT_PHASE_KEYS[props.agentPhase])
							: t(WORK_MODE_KEYS[props.workMode]),
						null,
						props.workMode !== "agent" || props.agentPhase !== DEFAULT_AGENT_PHASE,
					)}
				/>
				<ComposerPickerMenuPopup align="start" side="top">
					<MenuRadioGroup
						value={props.workMode}
						onValueChange={(value) => props.onSetWorkMode(value as WorkMode)}
					>
						<MenuGroupLabel>{t("picker.workMode")}</MenuGroupLabel>
						{WORK_MODES.map((entry) => (
							<MenuRadioItem
								key={entry}
								value={entry}
								className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
							>
								{t(entry === "agent" ? "workMode.agentAuto" : WORK_MODE_KEYS[entry])}
							</MenuRadioItem>
						))}
					</MenuRadioGroup>
				</ComposerPickerMenuPopup>
			</Menu>

			<div className="flex-1" />

			<Menu
				open={modelMenuOpen}
				onOpenChange={setModelMenuOpen}
				keepOpenOnSubmenuInteraction
			>
				<MenuTrigger render={trigger(triggerLabel, <ZapIcon className="size-3.5" />)} />
				<ComposerPickerMenuPopup
					align="start"
					side="top"
					fixedWidth
					className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
				>
					<MenuGroup>
						<MenuGroupLabel>{t("picker.provider")}</MenuGroupLabel>
						{providerGroups.length === 0 ? (
							<MenuItem className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME} disabled>
								{t("picker.noModels")}
							</MenuItem>
						) : (
							providerGroups.map((provider) => (
								<MenuSub key={provider.id} keepOpenOnFocusOut>
									<MenuSubTrigger className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}>
										<span className="min-w-0 flex-1 truncate">{provider.name}</span>
									</MenuSubTrigger>
									<ComposerPickerMenuSubPopup
										fixedWidth
										side="inline-end"
										className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
									>
										{/* The label belongs inside the radio group: Base UI takes the group
										    context from MenuRadioGroup, and a label outside one throws as
										    soon as the menu opens. */}
										<MenuRadioGroup
											value={props.fusion ? "" : modelKey ?? ""}
											onValueChange={(value) => {
												props.onSetModel(value);
												setModelMenuOpen(false);
											}}
										>
											<MenuGroupLabel>{provider.name}</MenuGroupLabel>
											{provider.models.map((option) => (
												<MenuRadioItem
													key={option.key}
													className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
													value={option.key}
												>
													<span className="truncate">{modelName(option)}</span>
												</MenuRadioItem>
											))}
										</MenuRadioGroup>
									</ComposerPickerMenuSubPopup>
								</MenuSub>
							))
						)}
					</MenuGroup>
					<MenuSeparator />
					<FusionPicker models={models} modelKey={modelKey} fusion={props.fusion} onApply={props.onSetFusion} />
				</ComposerPickerMenuPopup>
			</Menu>

			{props.fusion ? null : thinkingSupported ? (
				<Menu>
					<MenuTrigger
						render={trigger(
							thinkingLevel,
							<BrainIcon className="size-3.5" />,
							thinkingLevel !== "off",
						)}
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
								className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
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
		</>
	);
}
