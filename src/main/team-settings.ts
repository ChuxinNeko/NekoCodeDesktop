import { DEFAULT_TEAM, isTeamSettings, type TeamSettings } from "../shared/team";

let source: () => TeamSettings | undefined = () => undefined;

/** Read live from app preferences, so roster edits apply from the next message. */
export function configureTeamSettings(read: () => TeamSettings | undefined): void { source = read; }

export function currentTeamSettings(): TeamSettings {
	const value = source();
	return isTeamSettings(value) && value.members.length ? value : DEFAULT_TEAM;
}
