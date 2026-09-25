import { NEKO_LOCAL_WORKSPACE, type AcpAgentInfo } from "../../../../shared/acp";
import { useTranslation } from "../../i18n";
import { BotIcon, ChevronDownIcon, SettingsIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MENU_OPTION_CLASS_NAME } from "../chat/composerPickerStyles";

/** The display name of a workspace id. */
export function workspaceName(workspace: string, agents: readonly AcpAgentInfo[]): string {
	if (workspace === NEKO_LOCAL_WORKSPACE) return "NekoLocal";
	return agents.find((agent) => agent.id === workspace)?.name ?? workspace;
}

/**
 * Which agent the conversation is with: NekoLocal — NekoCode's own agent on the
 * models configured in settings — or an external agent reached over ACP.
 *
 * Sits above the composer because it decides what the next message goes to,
 * and the sidebar follows it: each workspace has a history of its own.
 */
export function WorkspacePicker({
	value,
	agents,
	disabled,
	onChange,
	onManage,
}: {
	value: string;
	/** Every configured agent; only enabled ones are offered. */
	agents: readonly AcpAgentInfo[];
	disabled?: boolean;
	onChange: (workspace: string) => void;
	onManage: () => void;
}) {
	const { t } = useTranslation();
	const enabled = agents.filter((agent) => agent.enabled);
	return (
		<div className="flex items-center gap-1 px-1 pb-1.5">
			<Menu>
				<MenuTrigger
					disabled={disabled}
					render={
						<Button
							className="h-6 gap-1 rounded-md px-1.5 text-[length:var(--app-font-size-ui-sm,11px)]"
							disabled={disabled}
							size="chip"
							title={t("workspace.pickerHint")}
							variant="ghost"
						>
							<BotIcon className="size-3.5" />
							<span className="max-w-40 truncate font-medium">{workspaceName(value, agents)}</span>
							<ChevronDownIcon className="size-3 opacity-60" />
						</Button>
					}
				/>
				<ComposerPickerMenuPopup align="start" side="top">
					<MenuRadioGroup onValueChange={(next) => onChange(next as string)} value={value}>
						<MenuGroupLabel>{t("workspace.label")}</MenuGroupLabel>
						<MenuRadioItem className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME} value={NEKO_LOCAL_WORKSPACE}>
							<span className="truncate">NekoLocal</span>
						</MenuRadioItem>
						{enabled.map((agent) => (
							<MenuRadioItem className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME} key={agent.id} value={agent.id}>
								<span className="truncate">{agent.name}</span>
							</MenuRadioItem>
						))}
					</MenuRadioGroup>
					<MenuSeparator />
					<MenuItem className={cn(COMPOSER_PICKER_MENU_OPTION_CLASS_NAME)} onClick={onManage}>
						<SettingsIcon className="size-3.5" />
						<span className="truncate">{t("workspace.manage")}</span>
					</MenuItem>
				</ComposerPickerMenuPopup>
			</Menu>
		</div>
	);
}
