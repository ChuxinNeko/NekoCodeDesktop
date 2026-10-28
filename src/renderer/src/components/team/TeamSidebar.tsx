import { useState } from "react";
import type { TeamMember } from "../../../../shared/team";
import type { TeamRoom, TeamWorkspaceSnapshot } from "../../../../shared/team-workspace";
import { useTranslation } from "../../i18n";
import { BookIcon, PanelLeftIcon, PlusIcon, SearchIcon, SettingsIcon, UsersIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { TeamAvatar, TeamGroupAvatar } from "./TeamAvatar";

export type TeamTab = "overview" | "chat" | "memory" | "settings";

/** Contact-first layout: main bot, recent conversations, then workspace tools. */
export function TeamSidebar({ state, tab, selected, onNavigate, onOpenRoom, onDirect, onNewGroup }: {
	state: TeamWorkspaceSnapshot;
	tab: TeamTab;
	selected: string | null;
	onNavigate: (tab: TeamTab) => void;
	onOpenRoom: (id: string) => void;
	onDirect: (member: TeamMember) => void;
	onNewGroup: () => void;
}) {
	const { language } = useTranslation();
	const label = (zh: string, en: string) => language === "zh-CN" ? zh : en;
	const [collapsed, setCollapsed] = useState(false);
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");
	const main = state.team.members.find(member => member.id === state.team.adminId);
	const latest = new Map<string, { text: string; at: number }>();
	const activity = new Map<string, number>();
	for (const work of state.work) {
		for (const key of [`member:${work.memberId}`, `room:${work.roomId}`]) activity.set(key, Math.max(activity.get(key) ?? 0, work.updatedAt));
	}
	for (const post of state.posts) {
		if (post.at >= (latest.get(post.roomId)?.at ?? 0)) latest.set(post.roomId, { text: post.text, at: post.at });
	}
	const directRooms = new Map(state.rooms.filter(room => room.direct && room.members.length === 1).map(room => [room.members[0], room]));
	const currentWork = (memberId?: string, roomId?: string) => state.work.filter(work => work.status === "working" &&
		(memberId ? work.memberId === memberId : work.roomId === roomId)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
	const memberActive = (member: TeamMember) => tab === "chat" && selected !== null && directRooms.get(member.id)?.id === selected;
	const entries = [
		...state.team.members.filter(member => member.id !== main?.id).map(member => {
			const room = directRooms.get(member.id);
			const post = room ? latest.get(room.id) : undefined;
			const work = currentWork(member.id);
			return { id: `member:${member.id}`, name: member.name, text: work?.tool || work?.task || post?.text || member.role,
				at: Math.max(post?.at ?? 0, activity.get(`member:${member.id}`) ?? 0, room?.createdAt ?? 0), working: !!work, active: memberActive(member), member, room: undefined as TeamRoom | undefined };
		}),
		...state.rooms.filter(room => !room.direct).map(room => {
			const post = latest.get(room.id);
			const work = currentWork(undefined, room.id);
			return { id: `room:${room.id}`, name: room.name, text: work?.tool || work?.task || post?.text || label("群聊", "Group conversation"),
				at: Math.max(post?.at ?? 0, activity.get(`room:${room.id}`) ?? 0, room.createdAt), working: !!work, active: tab === "chat" && selected === room.id, member: undefined, room };
		}),
	].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name, language));
	const needle = query.trim().toLocaleLowerCase();
	const visible = entries.filter(entry => !needle || `${entry.name} ${entry.text} ${entry.member?.role ?? ""}`.toLocaleLowerCase().includes(needle));
	const mainVisible = main && (!needle || `${main.name} ${main.role}`.toLocaleLowerCase().includes(needle));
	const iconButton = "shrink-0 rounded-full text-muted-foreground hover:text-foreground";
	const row = "flex min-h-[54px] w-full items-center gap-2 rounded-[10px] border-0 bg-transparent p-2 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring";
	return <aside aria-label="bot" data-team-sidebar={collapsed ? "collapsed" : "expanded"}
		className={cn("flex min-h-0 shrink-0 flex-col border-r border-border/40 bg-muted/15 px-3 pb-2 pt-3", collapsed ? "w-14 px-1.5" : "w-[280px] max-[900px]:w-60")}>
		<div className={cn("flex shrink-0 items-center gap-1", collapsed && "flex-col")}>
			<Button size="chip" variant="ghost" title={label("团队概览", "Overview")} onClick={() => onNavigate("overview")} className={cn("mr-auto gap-1.5 px-1 text-sm font-semibold", collapsed && "mx-auto")}>
				<UsersIcon className="size-[18px]" />{!collapsed ? <span>bot</span> : null}
			</Button>
			{!collapsed ? <Button size="icon-sm" variant="ghost" className={iconButton} aria-label={label("搜索成员与会话", "Search bots and conversations")} title={label("搜索", "Search")} onClick={() => { setSearching(value => !value); if (searching) setQuery(""); }}><SearchIcon className="size-4" /></Button> : null}
			<Button size="icon-sm" variant="ghost" className={iconButton} aria-label={label("创建群聊", "Create group")} title={label("创建群聊", "Create group")} onClick={onNewGroup}><PlusIcon className="size-4" /></Button>
			<Button size="icon-sm" variant="ghost" className={iconButton} aria-label={label(collapsed ? "展开侧边栏" : "收起侧边栏", collapsed ? "Expand sidebar" : "Collapse sidebar")} title={label(collapsed ? "展开侧边栏" : "收起侧边栏", collapsed ? "Expand sidebar" : "Collapse sidebar")} onClick={() => { setCollapsed(value => !value); setSearching(false); setQuery(""); }}><PanelLeftIcon className="size-4" /></Button>
		</div>
		{searching && !collapsed ? <div className="px-1 pb-1 pt-3"><Input autoFocus value={query} aria-label={label("搜索成员与会话", "Search bots and conversations")} placeholder={label("搜索成员与会话…", "Search bots and conversations…")} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setSearching(false); setQuery(""); } }} /></div> : null}
		<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]" aria-label={label("成员与会话", "Bots and conversations")}>
			{mainVisible ? <div className={cn("flex justify-center pb-4 pt-5", collapsed && "pb-2 pt-3")}>
				<button type="button" onClick={() => onDirect(main)} title={main.name} aria-label={main.name} aria-current={memberActive(main) ? "page" : undefined}
					className={cn("relative flex min-w-0 flex-col items-center gap-1 rounded-xl px-3 py-2 transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring", !collapsed && "w-28", memberActive(main) && "bg-foreground/6", collapsed && "px-1")}>
					<TeamAvatar member={main} size={collapsed ? 32 : 60} />
					{!collapsed ? <><span className="w-full truncate text-[13px]">{main.name}</span><span className="max-w-full truncate rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] text-muted-foreground">{main.role || label("主管", "Main bot")}</span></> : null}
					{currentWork(main.id) ? <span role="status" aria-label={label("工作中", "Working")} className="absolute right-1 top-1 size-1.5 rounded-full bg-emerald-500" /> : null}
				</button>
			</div> : null}
			<div className="space-y-[3px]">{visible.map(entry => <button type="button" key={entry.id} className={cn(row, entry.active && "bg-foreground/6", collapsed && "min-h-11 justify-center px-0")}
				title={collapsed ? entry.name : undefined} aria-label={entry.working ? `${entry.name} · ${label("工作中", "Working")}` : entry.name} aria-current={entry.active ? "page" : undefined}
				onClick={() => entry.member ? onDirect(entry.member) : onOpenRoom(entry.room!.id)}>
				<span className="relative shrink-0">{entry.member ? <TeamAvatar member={entry.member} size={36} /> : <TeamGroupAvatar members={state.team.members.filter(member => entry.room!.members.includes(member.id))} size={36} />}
					{entry.working ? <span className="absolute bottom-0 right-0 size-2 rounded-full bg-emerald-500 ring-2 ring-background" /> : null}</span>
				{!collapsed ? <span className="min-w-0 flex-1"><span className="block truncate text-[13px] leading-5">{entry.name}</span><span className="block truncate text-xs leading-[18px] text-muted-foreground">{entry.text}</span></span> : null}
			</button>)}</div>
			{!collapsed && !visible.length && !mainVisible ? <p className="px-2 py-8 text-center text-xs text-muted-foreground">{needle ? label("没有匹配的成员或会话", "No matching bots or conversations") : label("在设置中添加成员，或创建群聊", "Add a bot in settings or create a group")}</p> : null}
		</div>
		<nav aria-label={label("bot 工具", "bot tools")} className={cn("mt-2 flex shrink-0 items-center gap-1 border-t border-border/40 pt-2", collapsed && "flex-col")}>
			{[{ id: "memory" as const, name: label("记忆", "Memory"), Icon: BookIcon }, { id: "settings" as const, name: label("成员与设置", "Members & settings"), Icon: SettingsIcon }].map(({ id, name, Icon }) => <Button key={id} size={collapsed ? "icon-sm" : "chip"} variant="ghost" aria-label={name} title={name} aria-current={tab === id ? "page" : undefined} onClick={() => onNavigate(id)} className={cn("min-w-0 text-muted-foreground", !collapsed && "flex-1", tab === id && "bg-foreground/6 text-foreground")}><Icon className="size-4 shrink-0" />{!collapsed ? <span className="truncate">{name}</span> : null}</Button>)}
		</nav>
	</aside>;
}
