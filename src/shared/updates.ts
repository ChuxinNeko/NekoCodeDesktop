export const UPDATE_REPOSITORY = "ChuxinNeko/NekoCodeDesktop";
export const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;

export interface AppVersionInfo {
	version: string;
	development: boolean;
	releasesUrl: string;
}

export interface AppRelease {
	version: string;
	tag: string;
	name: string;
	url: string;
	notes: string;
	publishedAt: string | null;
}

export type UpdateError = "network" | "timeout" | "rate-limit" | "unavailable" | "invalid-release" | "invalid-version" | "server";
export type UpdateCheckResult = { checkedAt: number; currentVersion: string } & (
	| { status: "available" | "up-to-date" | "ahead"; release: AppRelease }
	| { status: "no-release" }
	| { status: "error"; error: UpdateError }
);

/** SemVer precedence; build metadata does not change precedence. Accept GitHub's v prefix. */
export function parseVersion(value: string): { core: bigint[]; prerelease: string[] } | null {
	const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
	if (!match) return null;
	const prerelease = match[4]?.split(".") ?? [];
	if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) return null;
	return { core: match.slice(1, 4).map(BigInt), prerelease };
}

export function compareVersions(left: string, right: string): number | null {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (!a || !b) return null;
	for (let i = 0; i < 3; i++) {
		if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
	}
	if (!a.prerelease.length || !b.prerelease.length)
		return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
	for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
		const x = a.prerelease[i], y = b.prerelease[i];
		if (x === y) continue;
		if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
		const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
		if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
		if (nx !== ny) return nx ? -1 : 1;
		return x > y ? 1 : -1;
	}
	return 0;
}
