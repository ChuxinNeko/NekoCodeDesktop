// First-run state for the setup flow: whether it has been completed or skipped,
// and the name the user asked to be called. Kept in localStorage like the other
// renderer-side settings (language, theme, last project).

const DONE_KEY = "nekocode:onboarded";
const NAME_KEY = "nekocode:user-name";

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// storage unavailable; the flow simply shows again next launch
	}
}

export function isOnboarded(): boolean {
	return read(DONE_KEY) === "1";
}

export function markOnboarded(): void {
	write(DONE_KEY, "1");
}

export function readUserName(): string {
	return read(NAME_KEY)?.trim() ?? "";
}

export function writeUserName(name: string): void {
	const trimmed = name.trim();
	write(NAME_KEY, trimmed ? trimmed : null);
}
