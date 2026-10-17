import { useId } from "react";
import { teamAvatarOf, teamHash, type TeamAvatar as Avatar, type TeamAvatarColor, type TeamAvatarShape, type TeamMember } from "../../../../shared/team";
import { cn } from "../../lib/utils";

/**
 * Team member avatars in the style of Grok's bots: a soft, coloured shape with two
 * slanted white eyes near its top right that blink now and then. Each member
 * blinks on its own rhythm (from its id), so a list of them never blinks in sync.
 * The blink is CSS only and stops under prefers-reduced-motion (see index.css).
 */
export const TEAM_AVATAR_FILL: Record<TeamAvatarColor, string> = {
	teal: "#5abaa5",
	orange: "#ec9f3a",
	indigo: "#735af0",
	violet: "#924ff6",
	blue: "#577cf7",
	coral: "#e87133",
};

/** Body outlines in a 32×32 box; eyes sit where each shape is widest near the top. */
const BODY: Record<TeamAvatarShape, { d: string; eyes: [number, number] }> = {
	orb: { d: "M16 2a14 14 0 1 1 0 28 14 14 0 0 1 0-28Z", eyes: [19.4, 10.6] },
	// A rounded triangle with a flat, wide base.
	pyramid: { d: "M13.4 4.6c1.2-1.9 4-1.9 5.2 0l10.6 17.5c1.5 2.5.4 5.4-2.6 5.6-3.4.3-6.9.4-10.6.4s-7.2-.1-10.6-.4c-3-.2-4.1-3.1-2.6-5.6Z", eyes: [17.6, 14.4] },
	// A plump rounded diamond.
	gem: { d: "M12.5 4.4c2-1.9 5-1.9 7 0l8.1 8.1c1.9 2 1.9 5 0 7l-8.1 8.1c-2 1.9-5 1.9-7 0l-8.1-8.1c-1.9-2-1.9-5 0-7Z", eyes: [18.6, 11.4] },
};

export function TeamAvatarGlyph({ avatar, size = 20, className, title, seed = "", blink = true }: {
	avatar: Avatar; size?: number; className?: string; title?: string; seed?: string; blink?: boolean;
}) {
	const id = useId().replace(/:/g, "");
	const body = BODY[avatar.shape];
	const [x, y] = body.eyes;
	const hash = teamHash(seed || `${avatar.shape}${avatar.color}`);
	// 4–8 s between blinks, offset so neighbours drift apart.
	const rhythm = { ["--blink-duration" as string]: `${4 + (hash % 40) / 10}s`, ["--blink-delay" as string]: `-${(hash % 70) / 10}s` };
	return (
		<svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label={title ?? `${avatar.color} ${avatar.shape}`} className={cn("shrink-0", className)}>
			{title ? <title>{title}</title> : null}
			<defs>
				<radialGradient id={`${id}-shine`} cx="0.3" cy="0.25" r="0.85">
					<stop offset="0" stopColor="#fff" stopOpacity="0.16" />
					<stop offset="1" stopColor="#fff" stopOpacity="0" />
				</radialGradient>
			</defs>
			<path d={body.d} fill={TEAM_AVATAR_FILL[avatar.color]} />
			<path d={body.d} fill={`url(#${id}-shine)`} />
			<g className={blink ? "team-avatar-eyes" : undefined} style={rhythm}>
				<rect x={x - 1.35} y={y - 2.9} width="2.7" height="5.8" rx="1.35" fill="#fff" transform={`rotate(-24 ${x} ${y})`} />
				<rect x={x + 3.6} y={y - 2.9} width="2.7" height="5.8" rx="1.35" fill="#fff" transform={`rotate(-24 ${x + 4.95} ${y})`} />
			</g>
		</svg>
	);
}

export function TeamAvatar({ member, size, className, blink }: { member: Pick<TeamMember, "id" | "avatar" | "name">; size?: number; className?: string; blink?: boolean }) {
	const avatar = teamAvatarOf(member);
	// An uploaded picture wins over the shape: it is what the user chose to see.
	if (avatar.image) {
		return (
			<img
				alt={`@${member.name}`}
				className={cn("shrink-0 rounded-full object-cover", className)}
				height={size}
				src={avatar.image}
				style={size ? { width: size, height: size } : undefined}
				title={`@${member.name}`}
				width={size}
			/>
		);
	}
	return <TeamAvatarGlyph avatar={avatar} size={size} className={className} title={`@${member.name}`} seed={member.id} blink={blink} />;
}

/** The whole team, like a group chat icon: up to three members huddled together. */
export function TeamGroupAvatar({ members, size = 20, className }: { members: Pick<TeamMember, "id" | "avatar" | "name">[]; size?: number; className?: string }) {
	const shown = members.slice(0, 3);
	const spots = [{ x: 0.25, y: 0, s: 0.5 }, { x: 0, y: 0.45, s: 0.55 }, { x: 0.45, y: 0.45, s: 0.55 }];
	return (
		<span className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }} aria-hidden>
			{shown.map((member, index) => {
				const spot = spots[index]!;
				return (
					<span key={member.id} className="absolute rounded-full" style={{ left: spot.x * size, top: spot.y * size, width: spot.s * size, height: spot.s * size,
						// A ring in the page colour separates overlapping members, like the reference.
						boxShadow: index ? "0 0 0 1.5px var(--color-background, #fff)" : undefined, background: index ? "var(--color-background, #fff)" : undefined }}>
						<TeamAvatar member={member} size={spot.s * size} />
					</span>
				);
			})}
		</span>
	);
}
