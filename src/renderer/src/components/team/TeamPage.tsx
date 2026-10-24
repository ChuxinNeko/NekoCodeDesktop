import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { TeamMemory, TeamRoom, TeamWorkspaceAction, TeamWorkspaceSnapshot } from "../../../../shared/team-workspace";
import type { SessionSummary } from "../../../../shared/agent";
import type { TeamMember } from "../../../../shared/team";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { BookIcon, PlusIcon, SettingsIcon, UsersIcon, MessageCircleIcon, XIcon } from "../../lib/icons";
import { TeamConversationMessages } from "./TeamConversationMessages";
import { TeamComposer } from "./TeamComposer";
import { CHAT_COLUMN_FRAME_CLASS_NAME, CHAT_BACKGROUND_CLASS_NAME } from "../chat/composerPickerStyles";
import { TeamSettings } from "../settings/TeamSettings";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { TeamAvatar } from "./TeamAvatar";
import { useHostDirectoryPicker } from "../HostDirectoryPicker";

type Tab = "overview" | "chat" | "memory" | "settings";

/** Independent team workspace: persisted identities, conversations, memories and live work. */
export function TeamPage({ cwd, onOpenSession }: { cwd: string | null; onOpenSession: (session: SessionSummary) => void }) {
	const { language, t } = useTranslation();
	const zh = language === "zh-CN";
	const label = (cn: string, en: string) => zh ? cn : en;
	const [state, setState] = useState<TeamWorkspaceSnapshot | null>(null);
	const [tab, setTab] = useState<Tab>("overview");
	const [selected, setSelected] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [roomDraft, setRoomDraft] = useState<Partial<TeamRoom> | null>(null);
	const [deletingRoom, setDeletingRoom] = useState<string | null>(null);
	const [memoryDraft, setMemoryDraft] = useState<Partial<TeamMemory> | null>(null);
	const [scope, setScope] = useState("team");
	const [query, setQuery] = useState("");
	const [models, setModels] = useState<{ key: string; label: string }[]>([]);
	const [roomModels, setRoomModels] = useState<Record<string, string>>({});
	const pickDirectory = useHostDirectoryPicker();
	const tail = useRef<HTMLDivElement>(null);
	const messageList = useRef<HTMLDivElement>(null);
	const followMessages = useRef(true);
	const alive = useRef(true);
	const refresh = useCallback(async () => {
		try { const next = await api.teamSnapshot(); if (alive.current) setState(next); }
		catch (cause) { if (alive.current) setError(errorMessage(cause)); }
	}, []);
	useEffect(() => {
		alive.current = true;
		void refresh();
		const unsubscribe = api.onTeamChanged(() => { void refresh(); });
		void api.codeIntelModels().then(result => { if (alive.current) setModels(result.chat); }).catch(() => undefined);
		return () => { alive.current = false; unsubscribe(); };
	}, [refresh]);
	const room = state?.rooms.find(room => room.id === selected);
	const model = selected ? roomModels[selected] ?? room?.modelKey ?? "" : "";
	const setModel = (value: string) => { if (selected) setRoomModels(values => ({ ...values, [selected]: value })); };
	const running = state?.work.filter(work => work.status === "working") ?? [];
	const roomWork = running.filter(work => work.roomId === selected);
	const posts = state?.posts.filter(post => post.roomId === selected) ?? [];
	const draft = selected ? drafts[selected] ?? "" : "";
	useEffect(() => { followMessages.current = true; }, [selected]);
	useEffect(() => { if (followMessages.current) tail.current?.scrollIntoView({ block: "end" }); }, [selected, posts.length, posts.at(-1)?.text.length]);
	const act = async (action: TeamWorkspaceAction) => {
		try { setError(null); const result = await api.teamAction(action); await refresh(); return result; }
		catch (cause) { setError(errorMessage(cause)); throw cause; }
	};
	const openRoom = (id: string) => { setSelected(id); setTab("chat"); setError(null); };
	const direct = async (member: TeamMember) => {
		if (!state) return;
		const known = state.rooms.find(room => room.direct && room.members.length === 1 && room.members[0] === member.id);
		if (known) { openRoom(known.id); return; }
		try {
			const result = await act({ type: "room.save", room: { name: member.name, members: [member.id], adminId: member.id, mode: "everyone", notice: "", cwd: cwd ?? "", direct: true } });
			if (result) openRoom(result.id);
		} catch { /* Error is shown by act. */ }
	};
	const send = async (text: string) => {
		if (!selected || !text.trim() || sending) return;
		setSending(true); setError(null);
		try {
			const result = await api.teamSend({ roomId: selected, text, ...(model ? { modelKey: model } : {}) });
			if (!result.accepted) throw new Error(result.error);
			setDrafts(values => values[selected]?.trim() === text.trim() ? { ...values, [selected]: "" } : values);
			await refresh();
		} catch (cause) { setError(errorMessage(cause)); }
		finally { setSending(false); }
	};
	const stop = (roomId: string, memberId?: string) => { void api.teamStop(roomId, memberId).then(refresh).catch(cause => setError(errorMessage(cause))); };
	const tabs = [{ id: "overview" as const, text: label("团队概览", "Overview"), Icon: UsersIcon }, { id: "chat" as const, text: label("会话", "Conversations"), Icon: MessageCircleIcon }, { id: "memory" as const, text: label("记忆", "Memory"), Icon: BookIcon }, { id: "settings" as const, text: label("成员与设置", "Members & settings"), Icon: SettingsIcon }];
	if (!state) return <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">{error ?? label("正在加载团队…", "Loading team…")}</div>;
	return <div className={cn("team-workspace flex h-full min-h-0 flex-1", CHAT_BACKGROUND_CLASS_NAME)} data-team-workspace>
		<aside className="flex w-56 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border/40 bg-muted/15 px-3 py-5 max-[900px]:w-48 max-[640px]:w-40">
			<div className="flex items-center gap-2.5 px-2 text-sm font-semibold"><span className="flex size-8 items-center justify-center rounded-xl bg-foreground/5"><UsersIcon className="size-4" /></span>{label("AI 团队", "AI team")}<span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground">{state.team.members.length}</span></div>
			<nav className="flex flex-col gap-1" aria-label={label("团队导航", "Team navigation")}>{tabs.map(({ Icon, ...item }) => <button type="button" key={item.id} onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined} className={cn("flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", tab === item.id && "bg-foreground/6 font-medium text-foreground")}><Icon className="size-3.5 shrink-0" />{item.text}</button>)}</nav>
			<div><div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground"><span>{label("群聊", "Groups")}</span><Button size="icon-xs" variant="ghost" title={label("创建群聊", "Create group")} onClick={() => setRoomDraft({ name: "", members: state.team.members.map(member => member.id), adminId: state.team.adminId, mode: "admin", notice: "", cwd: cwd ?? "" })}><PlusIcon className="size-3.5" /></Button></div>
				{state.rooms.filter(room => !room.direct).map(room => <button key={room.id} className={cn("mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-muted", selected === room.id && tab === "chat" && "bg-muted")} onClick={() => openRoom(room.id)}><MessageCircleIcon className="size-3.5 shrink-0" /><span className="truncate">{room.name}</span>{running.some(work => work.roomId === room.id) ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-emerald-500" /> : null}</button>)}
			</div>
			<div><div className="mb-3 text-[11px] text-muted-foreground">{label("成员私聊", "Members")}</div>{state.team.members.map(member => <button key={member.id} className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted" onClick={() => { void direct(member); }}><TeamAvatar member={member} size={25} /><span className="min-w-0 flex-1"><span className="block truncate text-xs">{member.name}</span><span className="block truncate text-[10px] text-muted-foreground">{member.role}</span></span>{running.some(work => work.memberId === member.id) ? <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" /> : null}</button>)}</div>
		</aside>
		<section className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border/40 px-5 py-3"><div className="min-w-0"><h1 className="truncate text-sm font-semibold">{tab === "chat" && room ? room.name : tabs.find(item => item.id === tab)?.text}</h1><p className="mt-1 max-w-xl truncate text-[11px] text-muted-foreground">{tab === "chat" && room ? room.members.map(id => state.team.members.find(member => member.id === id)?.name ?? id).join(" · ") : label("独立身份，共享目标，一起完成任务", "Individual minds. Shared goals. Work together.")}</p></div>
				{tab === "chat" && room ? <div className="flex shrink-0 gap-1"><Button size="icon-xs" variant="ghost" title={label("会话设置", "Conversation settings")} aria-label={label("会话设置", "Conversation settings")} onClick={() => setRoomDraft(room)}><SettingsIcon className="size-3.5" /></Button>{room.session ? <Button size="xs" variant="ghost" onClick={() => { void api.sessionList().then(sessions => { const session = sessions.find(session => session.id === room.session?.id); if (session) onOpenSession(session); else setError(label("会话暂不可用", "Session unavailable")); }).catch(cause => setError(errorMessage(cause))); }}>{label("完整记录", "Full transcript")}</Button> : null}</div> : null}
			</header>
			{error ? <div role="alert" className="flex items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/5 px-6 py-3 text-xs text-destructive">{error}<button aria-label={t("common.close")} onClick={() => setError(null)}><XIcon className="size-3.5" /></button></div> : null}
			{tab === "overview" ? <div className="team-overview flex-1 space-y-6 overflow-y-auto p-5">
				<div className="grid grid-cols-3 gap-3">{[{ value: state.team.members.length, text: label("团队成员", "Members") }, { value: running.length, text: label("正在工作", "Working") }, { value: state.rooms.filter(room => !room.direct).length, text: label("协作群聊", "Groups") }].map(item => <div key={item.text} className="rounded-2xl border border-border/40 bg-muted/15 p-4"><div className="text-2xl font-semibold tabular-nums">{item.value}</div><div className="mt-1 text-xs text-muted-foreground">{item.text}</div></div>)}</div>
				<div><div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-medium">{label("成员概览", "Team roster")}</h2><Button size="xs" variant="ghost" onClick={() => setTab("settings")}>{label("管理成员", "Manage members")}</Button></div><div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-3">{state.team.members.map(member => {
					const work = running.filter(work => work.memberId === member.id), main = member.main || member.id === state.team.adminId;
					return <article key={member.id} className="flex flex-col gap-3 rounded-2xl border border-border/40 bg-muted/15 p-4"><div className="flex items-center gap-3"><TeamAvatar member={member} size={38} /><div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm font-medium">{member.name}{main ? <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{label("主管", "Main")}</span> : null}</div><div className="truncate text-[11px] text-muted-foreground">{member.role}</div></div><span className={cn("size-2 rounded-full", work.length ? "bg-emerald-500" : "bg-muted-foreground/30")} title={work.length ? label("工作中", "Working") : label("空闲", "Idle")} /></div><p className="line-clamp-2 min-h-8 text-[11px] text-muted-foreground">{work[0]?.task || member.instructions || label("等待任务", "Ready for a task")}</p><div className="truncate text-[10px] text-muted-foreground">{member.modelKey || label("跟随会话模型", "Follow conversation model")} · {member.access === "read-only" ? label("只读", "Read-only") : label("完整工具", "Full tools")}</div><div className="flex gap-2"><Button size="xs" variant="chrome-outline" onClick={() => { void direct(member); }}>{label("私聊", "Chat")}</Button><Button size="xs" variant="ghost" onClick={() => { setScope(`member:${member.id}`); setTab("memory"); }}>{label("记忆", "Memory")}</Button>{work.map(item => <Button key={item.id} size="xs" variant="ghost" onClick={() => stop(item.roomId, member.id)}>{label("停止", "Stop")}</Button>)}</div></article>;
				})}</div></div>
				<div><h2 className="mb-3 text-xs font-medium">{label("最近活动", "Recent activity")}</h2>{state.work.length ? <div className="divide-y divide-border/50 rounded-xl border border-border/60">{state.work.slice(-15).reverse().map(work => <button key={work.id} className="flex w-full items-start gap-3 p-4 text-left hover:bg-muted/40" onClick={() => { if (state.rooms.some(room => room.id === work.roomId)) openRoom(work.roomId); }}><span className={cn("mt-1 size-1.5 shrink-0 rounded-full", work.status === "working" ? "bg-emerald-500" : work.status === "failed" ? "bg-destructive" : "bg-muted-foreground/40")} /><div className="min-w-0 flex-1"><div className="text-xs font-medium">{state.team.members.find(member => member.id === work.memberId)?.name ?? work.memberId} <span className="font-normal text-muted-foreground">· {work.status === "working" ? label("工作中", "Working") : work.status === "done" ? label("已完成", "Done") : work.status === "stopped" ? label("已停止", "Stopped") : label("失败", "Failed")}</span></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{work.tool || work.task}</p></div><time className="text-[10px] text-muted-foreground">{new Date(work.updatedAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}</time></button>)}</div> : <p className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">{label("与 Chief 私聊，或创建群聊开始协作。Chief 可以按任务需要自行创建成员。", "Chat with Chief or create a group to start. Chief can create teammates as needed.")}</p>}</div>
			</div> : null}
			{tab === "chat" ? room ? <>
				{room.notice ? <div className="px-5 pt-3"><div className={cn(CHAT_COLUMN_FRAME_CLASS_NAME, "rounded-xl bg-muted/35 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground")}>{room.notice}</div></div> : null}
				<div ref={messageList} onScroll={() => { const element = messageList.current; if (element) followMessages.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-6" aria-live="polite"><div className={cn(CHAT_COLUMN_FRAME_CLASS_NAME, "space-y-6")}>
					{!posts.length ? <p className="py-10 text-center text-xs text-muted-foreground">{label("发一条消息开始。使用 @成员名 或 @all 指定回复者。", "Start a conversation. Use @Name or @all to choose who answers.")}</p> : null}
					<TeamConversationMessages team={state.team} posts={posts} work={roomWork} onStop={stop} />
					<div ref={tail} />
				</div></div>
				<TeamComposer key={room.id} room={room} draft={draft} onDraftChange={text => setDrafts(values => ({ ...values, [room.id]: text }))}
					models={models} modelKey={model} onSetModel={setModel} sending={sending} working={roomWork.length > 0}
					onSend={text => { followMessages.current = true; void send(text); }} onStop={() => stop(room.id)} onSettings={() => setRoomDraft(room)} />
			</> : <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground"><MessageCircleIcon className="size-8 opacity-40" /><p className="text-xs">{label("从左侧选择成员或群聊", "Choose a member or group from the sidebar")}</p></div> : null}
			{tab === "memory" ? <div className="flex-1 space-y-4 overflow-y-auto p-6"><div className="flex flex-wrap items-center gap-3"><select aria-label={label("记忆范围", "Memory scope")} className="rounded-lg border border-border bg-background px-3 py-2 text-xs" value={scope} onChange={event => setScope(event.target.value)}><option value="team">{label("团队共享记忆", "Team memory")}</option>{state.team.members.map(member => <option key={member.id} value={`member:${member.id}`}>{member.name}</option>)}{state.rooms.filter(room => !room.direct).map(room => <option key={room.id} value={`room:${room.id}`}>{label("群聊", "Group")}: {room.name}</option>)}</select><Input className="min-w-36 flex-1" placeholder={label("搜索记忆…", "Search memory…")} aria-label={label("搜索记忆", "Search memory")} value={query} onChange={event => setQuery(event.target.value)} /><Button size="sm" variant="chrome-outline" onClick={() => setMemoryDraft({ scope, topic: "", text: "" })}><PlusIcon className="size-3.5" />{label("添加记忆", "Add memory")}</Button></div><p className="text-[11px] text-muted-foreground">{label("记忆会在下次任务中提供给成员。成员可读其他成员的记忆；只有主管可修改他人及团队记忆。", "Memories are available on the next task. Members may read others' memories; only Main Bots may edit others' or team memory.")}</p>{state.memory.filter(entry => entry.scope === scope && `${entry.topic} ${entry.text}`.toLowerCase().includes(query.toLowerCase())).map(entry => <article key={entry.id} className="space-y-3 rounded-2xl border border-border/40 bg-muted/15 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-xs font-medium">{entry.topic}</h3><Button size="xs" variant="ghost" onClick={() => setMemoryDraft(entry)}>{label("编辑", "Edit")}</Button></div><p className="whitespace-pre-wrap text-xs text-muted-foreground">{entry.text}</p></article>)}</div> : null}
			{tab === "settings" ? <div className="flex-1 overflow-y-auto p-6"><TeamSettings /></div> : null}
		</section>
		<Dialog.Root open={roomDraft !== null} onOpenChange={open => { if (!open) setRoomDraft(null); }}><Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" /><Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(480px,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl"><Dialog.Title className="text-sm font-semibold">{roomDraft?.id ? label("会话设置", "Conversation settings") : label("创建群聊", "Create group")}</Dialog.Title><Dialog.Description className="text-xs text-muted-foreground">{label("群聊共享工作目录、公告和群记忆。", "Groups share a working folder, notice and memory.")}</Dialog.Description>{roomDraft ? <>
			<label className="space-y-1 text-xs">{label("名称", "Name")}<Input value={roomDraft.name ?? ""} maxLength={80} onChange={event => setRoomDraft({ ...roomDraft, name: event.target.value })} /></label>
			{!roomDraft.direct ? <fieldset><legend className="mb-2 text-xs">{label("成员", "Members")}</legend><div className="flex flex-wrap gap-2">{state.team.members.map(member => <label key={member.id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"><input type="checkbox" checked={roomDraft.members?.includes(member.id) ?? false} onChange={event => { const members = event.target.checked ? [...roomDraft.members ?? [], member.id] : roomDraft.members?.filter(id => id !== member.id) ?? []; setRoomDraft({ ...roomDraft, members, adminId: members.includes(roomDraft.adminId ?? "") ? roomDraft.adminId : members[0] }); }} />{member.name}</label>)}</div></fieldset> : null}
			<label className="space-y-1 text-xs">{label("管理员", "Admin")}<select className="block w-full rounded-md border border-border bg-background px-2 py-2" value={roomDraft.adminId ?? ""} onChange={event => setRoomDraft({ ...roomDraft, adminId: event.target.value })}>{state.team.members.filter(member => roomDraft.members?.includes(member.id)).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
			<label className="space-y-1 text-xs">{label("回复方式", "Reply mode")}<select className="block w-full rounded-md border border-border bg-background px-2 py-2" value={roomDraft.mode ?? "admin"} onChange={event => setRoomDraft({ ...roomDraft, mode: event.target.value as TeamRoom["mode"] })}><option value="admin">{label("管理员协调", "Admin coordinates")}</option><option value="everyone">{label("所有成员回复", "Everyone replies")}</option></select></label>
			<label className="space-y-1 text-xs">{label("工作目录", "Working folder")}<div className="flex gap-2"><Input value={roomDraft.cwd ?? ""} onChange={event => setRoomDraft({ ...roomDraft, cwd: event.target.value })} /><Button size="sm" variant="chrome-outline" onClick={() => { void pickDirectory().then(path => { if (path) setRoomDraft({ ...roomDraft, cwd: path }); }); }}>{label("选择", "Choose")}</Button></div></label>
			<label className="space-y-1 text-xs">{label("群公告", "Group notice")}<Textarea value={roomDraft.notice ?? ""} maxLength={8000} onChange={event => setRoomDraft({ ...roomDraft, notice: event.target.value })} /></label>
			<div className="flex items-center justify-end gap-2">{roomDraft.id ? <Button size="sm" variant="destructive" onClick={() => setDeletingRoom(roomDraft.id!)}>{label("删除", "Delete")}</Button> : null}<Button size="sm" variant="ghost" onClick={() => setRoomDraft(null)}>{t("common.cancel")}</Button><Button size="sm" disabled={!roomDraft.name?.trim() || !roomDraft.members?.length} onClick={() => { void act({ type: "room.save", room: { id: roomDraft.id, name: roomDraft.name ?? "", members: roomDraft.members ?? [], adminId: roomDraft.adminId ?? "", mode: roomDraft.mode ?? "admin", notice: roomDraft.notice ?? "", cwd: roomDraft.cwd ?? "", direct: roomDraft.direct } }).then(result => { setRoomDraft(null); if (result) openRoom(result.id); }).catch(() => undefined); }}>{t("common.save")}</Button></div>
		</> : null}</Dialog.Popup></Dialog.Portal></Dialog.Root>
		<Dialog.Root open={memoryDraft !== null} onOpenChange={open => { if (!open) setMemoryDraft(null); }}><Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" /><Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex w-[min(480px,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl border border-border bg-background p-6 shadow-xl"><Dialog.Title className="text-sm font-semibold">{label("编辑记忆", "Edit memory")}</Dialog.Title><Dialog.Description className="text-xs text-muted-foreground">{label("保存经确认的事实、决定和长期偏好。", "Save verified facts, decisions and lasting preferences.")}</Dialog.Description>{memoryDraft ? <><Input aria-label={label("主题", "Topic")} placeholder={label("主题", "Topic")} maxLength={120} value={memoryDraft.topic ?? ""} onChange={event => setMemoryDraft({ ...memoryDraft, topic: event.target.value })} /><Textarea aria-label={label("内容", "Content")} value={memoryDraft.text ?? ""} maxLength={16000} onChange={event => setMemoryDraft({ ...memoryDraft, text: event.target.value })} /><div className="flex justify-end gap-2">{memoryDraft.id ? <Button size="sm" variant="destructive" onClick={() => { void act({ type: "memory.delete", id: memoryDraft.id! }).then(() => setMemoryDraft(null)).catch(() => undefined); }}>{label("删除", "Delete")}</Button> : null}<Button size="sm" variant="ghost" onClick={() => setMemoryDraft(null)}>{t("common.cancel")}</Button><Button size="sm" disabled={!memoryDraft.topic?.trim() || !memoryDraft.text?.trim()} onClick={() => { void act({ type: "memory.save", id: memoryDraft.id, scope: memoryDraft.scope ?? scope, topic: memoryDraft.topic ?? "", text: memoryDraft.text ?? "" }).then(() => setMemoryDraft(null)).catch(() => undefined); }}>{t("common.save")}</Button></div></> : null}</Dialog.Popup></Dialog.Portal></Dialog.Root>
		<ConfirmDialog open={deletingRoom !== null} onOpenChange={open => { if (!open) setDeletingRoom(null); }} title={label("删除会话", "Delete conversation")} description={label("删除此会话及其团队记录？原始 PI 会话仍可在侧栏查看。", "Delete this conversation and its team records? Its PI transcript remains in the sidebar.")} footer={<><Button size="sm" variant="ghost" onClick={() => setDeletingRoom(null)}>{t("common.cancel")}</Button><Button size="sm" variant="destructive" onClick={() => { if (deletingRoom) void act({ type: "room.delete", id: deletingRoom }).then(() => { setDeletingRoom(null); setRoomDraft(null); setSelected(null); }).catch(() => setDeletingRoom(null)); }}>{label("删除", "Delete")}</Button></>} />
	</div>;
}
