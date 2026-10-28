import type { TeamPost, TeamWork } from "../../../../shared/team-workspace";
import type { TeamSettings } from "../../../../shared/team";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Markdown } from "../chat/Markdown";
import { TeamAvatar } from "./TeamAvatar";

/** Message identity and order stay fixed while a member streams or delegates. */
export function TeamConversationMessages({ team, posts, work, onStop }: {
	team: TeamSettings; posts: TeamPost[]; work: TeamWork[]; onStop: (roomId: string, memberId: string) => void;
}) {
	const { language } = useTranslation();
	const zh = language === "zh-CN";
	return <>
		{posts.map(post => {
			const member = team.members.find(member => member.id === post.memberId);
			const user = post.memberId === "user";
			return <article key={post.id} data-team-post={post.id} data-message-kind={post.kind} className={cn("flex items-start gap-3", user && "flex-row-reverse")}>
				{user ? null : member ? <TeamAvatar member={member} size={28} /> : <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px]">↗</span>}
				<div className={cn("flex min-w-0 max-w-[85%] flex-col gap-1.5", user ? "items-end" : "items-start")}>
					<div className={cn("flex items-baseline gap-2 text-[11px]", user && "justify-end")}>{!user ? <span className="font-medium text-foreground/80">{post.name}</span> : null}<time className="text-[10px] tabular-nums text-muted-foreground/60">{new Date(post.at).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}</time></div>
					<div data-team-bubble={user ? "user" : "bot"} className={cn("team-bubble min-w-0 max-w-full rounded-2xl border border-border/40 bg-muted/60 px-4 py-3 text-[length:var(--app-font-size-ui,12px)] leading-relaxed [overflow-wrap:anywhere]", user ? "rounded-tr-md" : "rounded-tl-md", post.kind === "notice" && "text-muted-foreground", post.status === "failed" && "border-destructive/40")}>
						<Markdown text={post.text} mentions={team.members} streaming={post.status === "streaming"} />
						{post.status === "streaming" ? <span className="mt-2 block text-[10px] text-muted-foreground">{zh ? "正在输入…" : "Typing…"}</span> : null}
						{post.status === "failed" ? <span className="mt-2 block text-[10px] text-destructive">{zh ? "回复已中断" : "Reply interrupted"}</span> : null}
					</div>
				</div>
			</article>;
		})}
		{work.map(item => <div key={item.id} className="ml-10 flex w-fit max-w-[calc(100%-2.5rem)] items-center gap-2 rounded-full bg-muted/35 px-3 py-1.5 text-[11px] text-muted-foreground" data-team-working={item.id}>
			<span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
			<span className="min-w-0 truncate">{team.members.find(member => member.id === item.memberId)?.name ?? item.memberId} · {item.tool || (zh ? "正在工作…" : "Working…")}</span>
			<button type="button" className="shrink-0 rounded-full px-1.5 py-0.5 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onStop(item.roomId, item.memberId)}>{zh ? "停止" : "Stop"}</button>
		</div>)}
	</>;
}
