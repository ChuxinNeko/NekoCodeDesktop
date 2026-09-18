import { useId, useState } from "react";
import { modelLabel, type ModelOption, type ThinkingLevel } from "../../../../shared/agent";
import type { FusionConfig } from "../../../../shared/fusion";
import { useTranslation } from "../../i18n";
import { MenuItem, MenuSeparator, MenuSub, MenuSubTrigger } from "../ui/menu";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ComposerPickerMenuSubPopup, ComposerPickerSelectPopup } from "./ComposerPickerMenuPopup";

interface Props {
	models: ModelOption[];
	modelKey: string | null;
	fusion?: FusionConfig | null;
	onApply: (config: FusionConfig) => void;
}

export function FusionPicker(props: Props) {
	const { t } = useTranslation();
	const id = useId();
	const initial = (): FusionConfig => {
		const lead = props.models.find((m) => m.key === props.modelKey) ?? props.models[0];
		const sidekick = props.models.find((m) => m.key !== lead?.key) ?? lead;
		return props.fusion ?? {
			leadModelKey: lead?.key ?? "",
			leadThinkingLevel: preferredLevel(lead, "high"),
			sidekickModelKey: sidekick?.key ?? "",
			sidekickThinkingLevel: preferredLevel(sidekick, "low"),
		};
	};
	const [draft, setDraft] = useState(initial);
	const valid = props.models.some((m) => m.key === draft.leadModelKey) &&
		props.models.some((m) => m.key === draft.sidekickModelKey);
	return (
		<MenuSub keepOpenOnFocusOut onOpenChange={(open) => { if (open) setDraft(initial()); }}>
			<MenuSubTrigger disabled={!props.models.length}>
				<span className="flex-1">Fusion</span>
				{props.fusion ? <span aria-label={t("fusion.active")}>✓</span> : null}
			</MenuSubTrigger>
			<ComposerPickerMenuSubPopup className="w-80" side="inline-end">
				<div className="space-y-3 px-3 py-2 text-[length:var(--app-font-size-ui,12px)] leading-5">
					<div className="font-medium">Fusion</div>
					<p className="text-xs leading-relaxed text-muted-foreground">{t("fusion.description")}</p>
					{(["lead", "sidekick"] as const).map((role) => {
						const modelField = role === "lead" ? "leadModelKey" : "sidekickModelKey";
						const levelField = role === "lead" ? "leadThinkingLevel" : "sidekickThinkingLevel";
						const model = props.models.find((m) => m.key === draft[modelField]);
						return <div key={role} className="space-y-2">
							<div className="flex items-center justify-between gap-3">
								<span id={`${id}-${role}`}>{t(`fusion.${role}`)}</span>
								<Select value={draft[modelField]} onValueChange={(key) => {
									if (!key) return;
									const next = props.models.find((m) => m.key === key);
									setDraft((value) => ({ ...value, [modelField]: key,
										[levelField]: preferredLevel(next, value[levelField]) }));
								}}>
									<SelectTrigger aria-labelledby={`${id}-${role}`} size="sm" className="w-44 min-w-0">
										<SelectValue>{model ? modelLabel(model) : t("picker.noModel")}</SelectValue>
									</SelectTrigger>
									<ComposerPickerSelectPopup>
										{props.models.map((option) => <SelectItem key={option.key} value={option.key}>
											{modelLabel(option)}
										</SelectItem>)}
									</ComposerPickerSelectPopup>
								</Select>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span id={`${id}-${role}-thinking`} className="text-muted-foreground">{t("picker.thinking")}</span>
								<Select value={draft[levelField]} onValueChange={(value) => {
									if (value) setDraft((config) => ({ ...config, [levelField]: value as ThinkingLevel }));
								}}>
									<SelectTrigger aria-labelledby={`${id}-${role} ${id}-${role}-thinking`} size="sm" className="w-44 min-w-0">
										<SelectValue />
									</SelectTrigger>
									<ComposerPickerSelectPopup>
										{(model?.thinkingLevels ?? ["off"]).map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
									</ComposerPickerSelectPopup>
								</Select>
							</div>
						</div>;
					})}
				</div>
				<MenuSeparator />
				<MenuItem disabled={!valid} onClick={() => props.onApply(draft)}>{t("fusion.apply")}</MenuItem>
			</ComposerPickerMenuSubPopup>
		</MenuSub>
	);
}

function preferredLevel(model: ModelOption | undefined, preferred: ThinkingLevel): ThinkingLevel {
	const levels = model?.thinkingLevels ?? ["off"];
	return levels.includes(preferred) ? preferred : levels[0] ?? "off";
}
