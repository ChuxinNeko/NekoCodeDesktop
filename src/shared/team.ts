import type { ThinkingLevel } from "./agent";

/**
 * An AI team: long-lived members with their own role, instructions and model,
 * coordinated by one admin. Adapted from DS Bot's group chat with an admin
 * (https://github.com/Fei2411/DeepSeek-Bot, Apache-2.0): plain messages go to the
 * admin, which answers or hands work to members; `@Name` reaches a member directly.
 */
export interface TeamMember {
	/** Main members can create members and edit the roster. The admin is always main. */
	main?: boolean;
	id: string;
	name: string;
	/** Short role label shown to the team, e.g. "Coder". */
	role: string;
	/** The member's own instructions (personality, focus, rules). */
	instructions: string;
	/** `provider/model`; empty follows the chat's current model. */
	modelKey: string;
	thinkingLevel: ThinkingLevel;
	/** Read-only members can inspect but never change the workspace. */
	access: "full" | "read-only";
	/** Shape and colour of the member's little character; absent picks one from its id. */
	avatar?: TeamAvatar;
}

/** Avatars in the style of Grok's bots: a soft coloured shape with two white eyes that blink. */
export const TEAM_AVATAR_SHAPES = ["orb", "pyramid", "gem"] as const;
export const TEAM_AVATAR_COLORS = ["teal", "orange", "indigo", "violet", "blue", "coral"] as const;
export type TeamAvatarShape = (typeof TEAM_AVATAR_SHAPES)[number];
export type TeamAvatarColor = (typeof TEAM_AVATAR_COLORS)[number];
/**
 * A user-uploaded picture, held as a `data:` URL so the choice travels with the
 * member wherever the roster is read — no file path to keep in step. It is
 * downscaled to a small square in the renderer before it gets here, so the cap
 * is generous headroom rather than a working limit.
 */
export const TEAM_AVATAR_IMAGE_MAX_CHARS = 512 * 1024;
export interface TeamAvatar { shape: TeamAvatarShape; color: TeamAvatarColor; image?: string }

/** A data URL of an image, within the size the roster will carry. */
export function isTeamAvatarImage(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("data:image/") && value.length <= TEAM_AVATAR_IMAGE_MAX_CHARS;
}

export function isTeamAvatar(value: unknown): value is TeamAvatar {
	const avatar = value as TeamAvatar;
	return !!avatar && typeof avatar === "object" && (TEAM_AVATAR_SHAPES as readonly string[]).includes(avatar.shape) &&
		(TEAM_AVATAR_COLORS as readonly string[]).includes(avatar.color) &&
		(avatar.image === undefined || isTeamAvatarImage(avatar.image));
}

export function teamHash(text: string): number {
	let hash = 0;
	for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return hash;
}

/** The member's avatar: its own choice, else a stable pick from its id. */
export function teamAvatarOf(member: Pick<TeamMember, "id" | "avatar">): TeamAvatar {
	if (isTeamAvatar(member.avatar)) return member.avatar;
	const hash = teamHash(member.id);
	return { shape: TEAM_AVATAR_SHAPES[hash % TEAM_AVATAR_SHAPES.length], color: TEAM_AVATAR_COLORS[Math.floor(hash / 3) % TEAM_AVATAR_COLORS.length] };
}

export interface TeamSettings {
	members: TeamMember[];
	/** The member that receives plain messages and coordinates the others. */
	adminId: string;
	/** Run several assignments of one hand-off at the same time. */
	parallel: boolean;
	/** Members may hand work to other members (one level deep). */
	peerDelegation: boolean;
	/** Hand-offs allowed per user message, across the whole team. */
	maxAssignments: number;
}

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const TEAM_NAME_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;

export function isTeamMember(value: unknown): value is TeamMember {
	const member = value as TeamMember;
	return !!member && typeof member === "object" && typeof member.id === "string" && !!member.id &&
		typeof member.name === "string" && TEAM_NAME_PATTERN.test(member.name) && member.name.toLowerCase() !== "all" &&
		typeof member.role === "string" && member.role.length <= 60 &&
		typeof member.instructions === "string" && member.instructions.length <= 8000 &&
		typeof member.modelKey === "string" && LEVELS.has(member.thinkingLevel) &&
		(member.access === "full" || member.access === "read-only") &&
		(member.main === undefined || typeof member.main === "boolean") &&
		(member.avatar === undefined || isTeamAvatar(member.avatar));
}

export function isTeamSettings(value: unknown): value is TeamSettings {
	const team = value as TeamSettings;
	if (!team || typeof team !== "object" || !Array.isArray(team.members) || team.members.length > 12) return false;
	if (!team.members.every(isTeamMember)) return false;
	const names = new Set(team.members.map(member => member.name.toLowerCase()));
	const ids = new Set(team.members.map(member => member.id));
	return names.size === team.members.length && ids.size === team.members.length &&
		(team.members.length === 0 || ids.has(team.adminId)) && typeof team.adminId === "string" &&
		typeof team.parallel === "boolean" && typeof team.peerDelegation === "boolean" &&
		Number.isInteger(team.maxAssignments) && team.maxAssignments >= 1 && team.maxAssignments <= 50;
}

export const DEFAULT_TEAM: TeamSettings = {
	adminId: "chief",
	parallel: true,
	peerDelegation: false,
	maxAssignments: 8,
	members: [
		{ id: "chief", name: "Chief", role: "Team lead", modelKey: "", thinkingLevel: "medium", access: "full", avatar: { shape: "orb", color: "teal" },
			instructions: "Understand what the user wants, split it into clear pieces, hand them to the right teammates, check their results and give the user one coherent answer. Do small things yourself." },
		{ id: "coder", name: "Coder", role: "Engineer", modelKey: "", thinkingLevel: "low", access: "full", avatar: { shape: "pyramid", color: "indigo" },
			instructions: "Implement changes carefully, keep to the existing style, and run the relevant checks before reporting." },
		{ id: "reviewer", name: "Reviewer", role: "Reviewer", modelKey: "", thinkingLevel: "medium", access: "read-only", avatar: { shape: "gem", color: "violet" },
			instructions: "Review code and plans critically: correctness, edge cases, security and missed requirements. Report concrete findings with file and line." },
	],
};

/** `@Name` mentions in a message, matched case-insensitively against the roster. */
export function mentionedMembers(text: string, members: readonly TeamMember[]): TeamMember[] {
	const found: TeamMember[] = [];
	for (const match of text.matchAll(/(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_-]{1,32})/gu)) {
		const name = match[2].toLowerCase();
		if (name === "all") { for (const member of members) if (!found.includes(member)) found.push(member); continue; }
		const member = members.find(candidate => candidate.name.toLowerCase() === name);
		if (member && !found.includes(member)) found.push(member);
	}
	return found;
}
