import { DEFAULT_TEAM, isTeamSettings, type TeamSettings } from "../shared/team";

let source: () => TeamSettings | undefined = () => undefined;
let writer: ((team: TeamSettings) => void) | undefined;

/** Read live from app preferences, so roster edits apply from the next message. */
export function configureTeamSettings(read: () => TeamSettings | undefined, write?: (team: TeamSettings) => void): void { source = read; writer = write; }

export function updateTeamSettings(change: (team: TeamSettings) => TeamSettings): TeamSettings {
	if (!writer) throw new Error("Team settings are not writable");
	const next = change(structuredClone(currentTeamSettings()));
	if (!isTeamSettings(next) || !next.members.length) throw new Error("Invalid team settings");
	writer(next);
	return next;
}

export function currentTeamSettings(): TeamSettings {
	const value = source();
	return isTeamSettings(value) && value.members.length ? value : DEFAULT_TEAM;
}
