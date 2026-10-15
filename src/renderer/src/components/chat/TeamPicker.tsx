import { useState } from "react";
import { modelLabel, type ModelOption } from "../../../../shared/agent";
import type { FusionConfig } from "../../../../shared/fusion";
import { DEFAULT_TEAM, type TeamSettings } from "../../../../shared/team";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { TeamAvatar, TeamGroupAvatar } from "../team/TeamAvatar";
import { MenuItem, MenuSeparator, MenuSub, MenuSubTrigger } from "../ui/menu";
import { ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";

interface Props {
	models: ModelOption[];
	modelKey: string | null;
	fusion?: FusionConfig | null;
	onApply: (config: FusionConfig) => void;
}

/**
 * The AI team as a model choice: the admin from Settings → Team answers plain
 * messages and hands work to members; `@Name` talks to one member directly.
 * Members without their own model follow the chat model picked here.
 */
export function TeamPicker(props: Props) {
	const { t } = useTranslation();
	const [team, setTeam] = useState<TeamSettings | null>(null);
	const active = props.fusion?.strategy === "team";
	const chat = props.models.find((m) => m.key === (active ? props.fusion?.leadModelKey : props.modelKey)) ?? props.models[0];
	const roster = team ?? DEFAULT_TEAM;
	const modelOf = (key: string) => {
		if (!key) return t("team.followChatModel");
		const model = props.models.find((m) => m.key === key);
		return model ? modelLabel(model, props.models) : `${key} · ${t("team.modelMissing")}`;
	};
	return (
		<MenuSub keepOpenOnFocusOut onOpenChange={(open) => {
			if (open) api.preferencesGet().then((preferences) => setTeam(preferences.team)).catch(() => setTeam(null));
		}}>
			<MenuSubTrigger disabled={!props.models.length}>
				<TeamGroupAvatar members={roster.members} size={16} />
				<span className="flex-1">{t("team.title")}</span>
				{active ? <span aria-label={t("team.active")}>✓</span> : null}
			</MenuSubTrigger>
			<ComposerPickerMenuSubPopup className="w-80" side="inline-end">
				<div className="space-y-2 px-3 py-2 text-[length:var(--app-font-size-ui,12px)] leading-5">
					<div className="font-medium">{t("team.title")}</div>
					<p className="text-xs leading-relaxed text-muted-foreground">{t("team.pickerDescription")}</p>
					<ul className="space-y-1">
						{roster.members.map((member) => (
							<li key={member.id} className="flex min-w-0 items-center gap-2">
								<TeamAvatar member={member} size={22} />
								<span className="flex min-w-0 flex-col">
									<span className="truncate">
										@{member.name}
										<span className="text-muted-foreground"> · {member.role || t("team.member")}</span>
										{member.id === roster.adminId ? <span className="text-muted-foreground"> · {t("team.admin")}</span> : null}
									</span>
									<span className="truncate text-xs text-muted-foreground">
										{modelOf(member.modelKey)} · {member.thinkingLevel}{member.access === "read-only" ? ` · ${t("team.readOnly")}` : ""}
									</span>
								</span>
							</li>
						))}
					</ul>
					<p className="text-xs text-muted-foreground">{t("team.pickerChatModel", { model: chat ? modelLabel(chat, props.models) : t("picker.noModel") })}</p>
					<p className="text-xs text-muted-foreground">{t("team.pickerEditHint")}</p>
				</div>
				<MenuSeparator />
				<MenuItem disabled={!chat || !roster.members.length} onClick={() => {
					if (!chat) return;
					const levels = chat.thinkingLevels ?? ["off"];
					const level = levels.includes("medium") ? "medium" : levels[0] ?? "off";
					props.onApply({ orchestration: "engine", strategy: "team", leadModelKey: chat.key, sidekickModelKey: chat.key,
						leadThinkingLevel: level, sidekickThinkingLevel: level, adaptiveRouting: false });
				}}>{t("team.apply")}</MenuItem>
			</ComposerPickerMenuSubPopup>
		</MenuSub>
	);
}
