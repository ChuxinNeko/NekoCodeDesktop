import { memo, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_TEAM, teamAvatarOf, type TeamMember, type TeamSettings } from "../../../../shared/team";
import type { TeamThreadItem, TeamThreadTurn } from "../../../../shared/team-thread";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Markdown } from "../chat/Markdown";
import { TEAM_AVATAR_FILL, TeamAvatar } from "./TeamAvatar";

/** The roster for names in a thread; refreshed whenever a run shows up, since settings apply per message. */
let lastRoster: TeamSettings = DEFAULT_TEAM;
function useTeamRoster(key: string): TeamSettings {
	const [team, setTeam] = useState<TeamSettings>(lastRoster);
	useEffect(() => {
		let live = true;
		api.preferencesGet().then(preferences => { if (preferences.team) lastRoster = preferences.team; if (live && preferences.team) setTeam(preferences.team); }).catch(() => undefined);
		return () => { live = false; };
	}, [key]);
	return team;
}

function memberOf(team: TeamSettings, name: string): Pick<TeamMember, "id" | "name" | "avatar"> & { role?: string } {
	return team.members.find(member => member.name.toLowerCase() === name.toLowerCase()) ?? { id: `name:${name.toLowerCase()}`, name };
}

function Mention({ team, name }: { team: TeamSettings; name: string }) {
	const member = memberOf(team, name);
	return <span className="font-medium" style={{ color: TEAM_AVATAR_FILL[teamAvatarOf(member).color] }}>@{member.name}</span>;
}

function TypingDots() {
	return (
		<span className="team-typing inline-flex items-center gap-1 py-1" aria-hidden>
			<span /><span /><span />
		</span>
	);
}

/** Avatar on the left, name above, content in a bubble — one message of the team's group chat. */
function MessageFrame({ team, name, continued, failed, children, footer, id }: { team: TeamSettings; name: string; continued?: boolean; failed?: boolean;
	children: ReactNode; footer?: ReactNode; id?: string }) {
	const { t } = useTranslation();
	const member = memberOf(team, name);
	const admin = team.members.find(candidate => candidate.id === team.adminId)?.name.toLowerCase() === name.toLowerCase();
	return (
		<div className={cn("flex w-full items-start gap-2.5", continued && "-mt-1.5")} data-team-message={id}>
			{/* Consecutive messages from one member share its avatar and name, as in a group chat. */}
			{continued ? <span className="w-[30px] shrink-0" /> : <TeamAvatar member={member} size={30} className="mt-0.5" />}
			<div className="flex min-w-0 max-w-[85%] flex-col items-start gap-1">
				{continued ? null : <div className="flex items-baseline gap-1.5 text-[length:var(--app-font-size-ui-xs,11px)] text-muted-foreground">
					<span className="font-medium text-foreground/80">{member.name}</span>
					{member.role ? <span>{member.role}</span> : null}
					{admin ? <span className="rounded bg-muted px-1 text-[10px] leading-4">{t("team.admin")}</span> : null}
				</div>}
				<div className={cn("team-bubble min-w-0 max-w-full rounded-2xl rounded-tl-md px-3 py-2",
					"bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-[length:var(--app-font-size-chat,13px)]",
					failed && "ring-1 ring-destructive/40")}>
					{children}
				</div>
				{footer}
			</div>
		</div>
	);
}

const Bubble = memo(function Bubble({ item, team, continued }: { item: TeamThreadItem; team: TeamSettings; continued: boolean }) {
	return (
		<MessageFrame team={team} name={item.member} continued={continued} failed={item.kind === "message" && item.status === "failed"} id={item.id}>
			{item.kind === "assign" ? (
				<div className="whitespace-pre-wrap break-words"><Mention team={team} name={item.to} /> {item.task}</div>
			) : (
				<>
					{item.tools.length ? (
						<ul className={cn("flex flex-col gap-0.5 text-[length:var(--app-font-size-ui-xs,11px)] text-muted-foreground", item.text.trim() && "mb-1")}>
							{item.tools.map(tool => (
								<li key={tool.id} className="flex min-w-0 items-center gap-1.5">
									<span className={cn("size-1.5 shrink-0 rounded-full", tool.status === "running" ? "animate-pulse bg-foreground/50" :
										tool.status === "failed" ? "bg-destructive" : "bg-foreground/25")} />
									<span className="shrink-0 font-medium">{tool.name}</span>
									{tool.detail ? <span className="truncate font-mono">{tool.detail}</span> : null}
								</li>
							))}
						</ul>
					) : null}
					{item.text.trim() ? (
						<div className="max-h-80 overflow-auto"><Markdown text={item.text} mentions={team.members} streaming={item.status === "running"} /></div>
					) : item.status === "running" ? <TypingDots /> : null}
					{item.error ? <p role="alert" className="mt-1 break-words text-[length:var(--app-font-size-ui-xs,11px)] text-destructive">{item.error}</p> : null}
				</>
			)}
		</MessageFrame>
	);
});

/**
 * The turn's final answer — a normal transcript reply — sent by the bot that wrote it.
 * Its content and actions stay the transcript's own; only the frame is the group chat's.
 */
export function TeamFinalMessage({ turn, children, footer }: { turn: TeamThreadTurn; children: ReactNode; footer?: ReactNode }) {
	const team = useTeamRoster(turn.prompt);
	const name = turn.final?.member;
	if (!name) return <div className="flex w-full flex-col gap-2">{footer}</div>;
	return <MessageFrame team={team} name={name} footer={footer}>{children}</MessageFrame>;
}

/** A team run drawn as a QQ-style group chat: avatar on the left, name above, message in a bubble. */
export const TeamThread = memo(function TeamThread({ turn }: { turn: TeamThreadTurn }) {
	const team = useTeamRoster(turn.prompt);
	if (!turn.items.length) return null;
	return (
		<div className="flex flex-col gap-3 pt-1" data-team-thread="">
			{turn.items.map((item, index) => <Bubble key={item.id} item={item} team={team} continued={turn.items[index - 1]?.member.toLowerCase() === item.member.toLowerCase()} />)}
		</div>
	);
});
