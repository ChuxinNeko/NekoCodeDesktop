/** Server-local OAuth wire contract. Keep compatible with src/shared/github-oauth.ts in the desktop app.
 * This backend must deploy independently of the desktop source tree. */
export type GitHubAuthorizationMethod = "browser" | "device";

/** Public progress only: neither device secrets nor GitHub tokens cross IPC. */
export interface GitHubAuthorization {
	id: string;
	method: GitHubAuthorizationMethod;
	url: string;
	userCode?: string;
	expiresAt: number;
	interval: number;
	installationUrl?: string;
}

/** Main process ↔ public server only. Never send these fields to the renderer. */
export interface GitHubOAuthCredentials {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	refreshExpiresAt?: number;
}

export interface GitHubOAuthGrant {
	credentials: GitHubOAuthCredentials;
	method: GitHubAuthorizationMethod;
	installationUrl?: string;
}

export function validGitHubCredentials(value: unknown): value is GitHubOAuthCredentials {
	if (!value || typeof value !== "object") return false;
	const c = value as GitHubOAuthCredentials;
	const token = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/\s/.test(v);
	return token(c.accessToken) && (c.refreshToken === undefined || token(c.refreshToken)) &&
		[c.expiresAt, c.refreshExpiresAt].every(v => v === undefined || (typeof v === "number" && Number.isFinite(v) && v > 0));
}
