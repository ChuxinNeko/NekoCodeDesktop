import type { TeamRoom } from "../../../../shared/team-workspace";
import { useTranslation } from "../../i18n";
import { ChevronDownIcon, FolderOpenIcon, UsersIcon } from "../../lib/icons";
import { projectLabel } from "../../../../shared/paths";
import { ComposerShell } from "../chat/ComposerShell";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MENU_OPTION_CLASS_NAME, COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

/** Uses the main chat's input, keyboard shortcuts, glass material and model-menu chrome. */
export function TeamComposer({ room, draft, onDraftChange, models, modelKey, onSetModel, sending, working, onSend, onStop, onSettings }: {
	room: TeamRoom;
	draft: string;
	onDraftChange: (text: string) => void;
	models: { key: string; label: string }[];
	modelKey: string;
	onSetModel: (key: string) => void;
	sending: boolean;
	working: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
	onSettings: () => void;
}) {
	const { language } = useTranslation();
	const zh = language === "zh-CN";
	const defaultModel = zh ? "默认模型" : "Default model";
	const currentModel = models.find((model) => model.key === modelKey)?.label ?? (modelKey || defaultModel);
	return <ComposerShell
		className="team-composer shrink-0 pt-3"
		draft={draft}
		onDraftChange={onDraftChange}
		clearOnSend={false}
		disabled={sending}
		queueScope={room.id}
		allowImageAttachments={false}
		streaming={working}
		onAbort={onStop}
		onSend={(request) => onSend(request.text)}
		placeholder={room.direct ? (zh ? `发送给 ${room.name}…` : `Message ${room.name}…`) : (zh ? "发送消息，@成员或 @all 指定回复者…" : "Message the team, @Name or @all to choose who replies…")}
		inlineToolbar={<Menu>
			<MenuTrigger disabled={sending} render={<Button size="chip" variant="ghost" className={COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME} aria-label={zh ? "会话模型" : "Conversation model"} title={currentModel}>
				<span className="truncate">{currentModel}</span><ChevronDownIcon className="size-3 shrink-0 opacity-60" />
			</Button>} />
			<ComposerPickerMenuPopup align="end" side="top" className="max-h-80 overflow-y-auto">
				<MenuRadioGroup value={modelKey} onValueChange={(value) => onSetModel(String(value))}>
					<MenuGroupLabel>{zh ? "会话模型" : "Conversation model"}</MenuGroupLabel>
					<MenuRadioItem value="" className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}>{defaultModel}</MenuRadioItem>
					{models.map((model) => <MenuRadioItem key={model.key} value={model.key} className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}><span className="truncate">{model.label}</span></MenuRadioItem>)}
				</MenuRadioGroup>
			</ComposerPickerMenuPopup>
		</Menu>}
		toolbar={<>
			<Button size="chip" variant="ghost" onClick={onSettings} className={COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME}>
				<UsersIcon className="size-3.5 shrink-0" /><span>{room.direct ? (zh ? "私聊" : "Direct message") : room.mode === "admin" ? (zh ? "主管协调" : "Admin coordinates") : (zh ? "全员回复" : "Everyone replies")}</span>
				<ChevronDownIcon className="size-3 opacity-60" />
			</Button>
			{room.cwd ? <span className="flex min-w-0 max-w-52 items-center gap-1.5 px-2 text-[11px] text-muted-foreground" title={room.cwd}><FolderOpenIcon className="size-3.5 shrink-0" /><span className="truncate">{projectLabel(room.cwd)}</span></span> : null}
		</>}
	/>;
}
