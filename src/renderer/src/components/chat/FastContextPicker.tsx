import { useId, useState } from "react";
import { modelLabel, type ModelOption, type ThinkingLevel } from "../../../../shared/agent";
import type { FastContextConfig } from "../../../../shared/fast-context";
import { useTranslation } from "../../i18n";
import { MenuItem, MenuSeparator, MenuSub, MenuSubTrigger } from "../ui/menu";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ComposerPickerMenuSubPopup, ComposerPickerSelectPopup } from "./ComposerPickerMenuPopup";

const AUTO_VALUE = "__auto__";

interface Props {
	models: ModelOption[];
	modelKey: string | null;
	fastContext: FastContextConfig;
	onApply: (config: FastContextConfig) => void;
}

export function FastContextPicker(props: Props) {
	const { t } = useTranslation();
	const id = useId();
	const initial = (): FastContextConfig => ({ ...props.fastContext });
	const [draft, setDraft] = useState(initial);
	const selected = draft.modelKey === null
		? undefined
		: props.models.find((m) => m.key === draft.modelKey);
	const fallback = props.models.find((m) => m.key === props.modelKey) ?? props.models[0];
	const levels = (selected ?? fallback)?.thinkingLevels ?? ["off" as ThinkingLevel];
	const valid = draft.modelKey === null || !!selected;
	const pickLevel = (model: ModelOption | undefined, current: ThinkingLevel): ThinkingLevel => {
		const supported = model?.thinkingLevels ?? ["off" as ThinkingLevel];
		return supported.includes(current)
			? current
			: supported.includes("low")
				? "low"
				: supported[0] ?? "off";
	};
	return (
		<MenuSub keepOpenOnFocusOut onOpenChange={(open) => { if (open) setDraft(initial()); }}>
			<MenuSubTrigger>
				<span className="flex-1">{t("fastContext.title")}</span>
				{props.fastContext.modelKey !== null ? <span aria-label={t("fusion.active")}>✓</span> : null}
			</MenuSubTrigger>
			<ComposerPickerMenuSubPopup className="w-80" side="inline-end">
				<div className="space-y-3 px-3 py-2 text-[length:var(--app-font-size-ui,12px)] leading-5">
					<div className="font-medium">{t("fastContext.title")}</div>
					<p className="text-xs leading-relaxed text-muted-foreground">{t("fastContext.description")}</p>
					<div className="flex items-center justify-between gap-3">
						<span id={`${id}-model`}>{t("picker.model")}</span>
						<Select
							value={draft.modelKey ?? AUTO_VALUE}
							onValueChange={(key) => {
								if (key === undefined) return;
								const next = key === AUTO_VALUE ? null : key;
								setDraft((value) => ({
									modelKey: next,
									thinkingLevel: pickLevel(
										next === null ? fallback : props.models.find((m) => m.key === next),
										value.thinkingLevel,
									),
								}));
							}}
						>
							<SelectTrigger aria-labelledby={`${id}-model`} size="sm" className="w-44 min-w-0">
								<SelectValue>
									{draft.modelKey === null
										? t("fastContext.automatic")
										: selected ? modelLabel(selected) : t("picker.noModel")}
								</SelectValue>
							</SelectTrigger>
							<ComposerPickerSelectPopup>
								<SelectItem value={AUTO_VALUE}>{t("fastContext.automatic")}</SelectItem>
								{props.models.map((option) => (
									<SelectItem key={option.key} value={option.key}>
										{modelLabel(option)}
									</SelectItem>
								))}
							</ComposerPickerSelectPopup>
						</Select>
					</div>
					<div className="flex items-center justify-between gap-3">
						<span id={`${id}-thinking`} className="text-muted-foreground">{t("picker.thinking")}</span>
						<Select
							value={draft.thinkingLevel}
							onValueChange={(value) => {
								if (value) setDraft((config) => ({ ...config, thinkingLevel: value as ThinkingLevel }));
							}}
						>
							<SelectTrigger aria-labelledby={`${id}-model ${id}-thinking`} size="sm" className="w-44 min-w-0">
								<SelectValue />
							</SelectTrigger>
							<ComposerPickerSelectPopup>
								{levels.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
							</ComposerPickerSelectPopup>
						</Select>
					</div>
				</div>
				<MenuSeparator />
				<MenuItem
					disabled={!valid}
					onClick={() => props.onApply({
						modelKey: draft.modelKey,
						thinkingLevel: levels.includes(draft.thinkingLevel)
							? draft.thinkingLevel
							: pickLevel(selected ?? fallback, draft.thinkingLevel),
					})}
				>
					{t("fastContext.apply")}
				</MenuItem>
			</ComposerPickerMenuSubPopup>
		</MenuSub>
	);
}
