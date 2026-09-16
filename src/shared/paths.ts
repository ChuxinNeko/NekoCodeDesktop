/** Display rules for the open project directory, shared by the sidebar, title bar and welcome screen. */

/**
 * Last path segment of a directory — what the sidebar and the title bar show.
 * The home directory gets `~` instead: its basename is the account name, which
 * says nothing about the project and is what a fresh install opens in.
 */
export function projectLabel(cwd: string | null, homeDir = ""): string {
	if (!cwd) return "No project";
	if (shortenPath(cwd, homeDir) === "~") return "~";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}

/**
 * Full path with the home directory folded to `~`, the way a shell prompt writes
 * it. Separators are left alone so a Windows path still reads as a Windows path.
 */
export function shortenPath(path: string | null, homeDir: string): string {
	if (!path) return "";
	if (!homeDir) return path;
	const normalize = (value: string) => value.replace(/[\\/]+$/, "");
	const home = normalize(homeDir);
	const target = normalize(path);
	if (target === home) return "~";
	// Compare case-insensitively: Windows paths round-trip through APIs that
	// disagree about the drive letter's case.
	const prefix = home.toLowerCase();
	const candidate = target.toLowerCase();
	if (!candidate.startsWith(prefix)) return path;
	const rest = target.slice(home.length);
	if (!/^[\\/]/.test(rest)) return path;
	return `~${rest}`;
}
