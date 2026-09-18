/**
 * Antigravity sign-in, over Google's OAuth and Cloud Code's control plane.
 *
 * Ported from CLIProxyAPI: `internal/auth/antigravity/{constants,auth}.go` and
 * the refresh half of `internal/runtime/executor/antigravity_executor_auth.go`.
 *
 * Protocol constants follow that checkout, not this application's identity.
 * Node/OpenSSL and Go's TLS stacks are not byte-identical.
 */

import { formatAntigravityError, readAntigravityErrorBody } from "./antigravity-error";

export const ANTIGRAVITY_CLIENT_ID =
	"1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
/**
 * Public by construction: an installed-app OAuth client cannot keep a secret,
 * and Google's flow requires it to be sent. It is not a credential of the user.
 */
export const ANTIGRAVITY_CLIENT_SECRET = "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";

export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}/oauth-callback`;

export const ANTIGRAVITY_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
const API_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const DAILY_API_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";

/**
 * The client version reported to Cloud Code. The real client reads this from a
 * hub manifest; this is the floor it falls back to, and Cloud Code refuses
 * newer models to clients below 2.9.0 — so it must not be lowered.
 */
export const ANTIGRAVITY_VERSION = "2.9.1";
const HUB_PLATFORM = "darwin/arm64";

/** Short form: userinfo, loadCodeAssist, and generate/stream requests. */
export const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_VERSION} ${HUB_PLATFORM}`;
/** Long form: the control plane's onboardUser call. */
export const ANTIGRAVITY_ONBOARD_USER_AGENT = `${ANTIGRAVITY_USER_AGENT} google-api-nodejs-client/10.3.0`;
export const ANTIGRAVITY_GOOG_API_CLIENT = "gl-node/22.21.1";
/**
 * The reference explicitly sets this value on token refresh requests.
 */
export const ANTIGRAVITY_REFRESH_USER_AGENT = "Go-http-client/2.0";

const ONBOARD_MAX_ATTEMPTS = 5;
const ONBOARD_POLL_INTERVAL_MS = 2000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AntigravityIdentity { version: string; userAgent: string; onboardUserAgent: string }
export const ANTIGRAVITY_IDENTITY: AntigravityIdentity = {
	version: ANTIGRAVITY_VERSION, userAgent: ANTIGRAVITY_USER_AGENT, onboardUserAgent: ANTIGRAVITY_ONBOARD_USER_AGENT,
};

/** internal/misc/antigravity_version.go: manifest, headers, limit and fallback. */
export async function fetchAntigravityIdentity(fetch: FetchLike): Promise<AntigravityIdentity> {
	try {
		const response = await fetch("https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml", {
			headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) { await response.body?.cancel(); return ANTIGRAVITY_IDENTITY; }
		const reader = response.body?.getReader();
		if (!reader) return ANTIGRAVITY_IDENTITY;
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (length < 4096) {
				const next = await reader.read();
				if (next.done) break;
				const chunk = next.value.subarray(0, 4096 - length);
				chunks.push(chunk); length += chunk.length;
			}
		} finally { await reader.cancel(); reader.releaseLock(); }
		const manifest = Buffer.concat(chunks).toString("utf8");
		const version = /^version:\s*["']?(\d+\.\d+\.\d+)["']?\s*(?:#.*)?$/m.exec(manifest)?.[1];
		if (!version) return ANTIGRAVITY_IDENTITY;
		const userAgent = `antigravity/hub/${version} ${HUB_PLATFORM}`;
		return { version, userAgent, onboardUserAgent: `${userAgent} google-api-nodejs-client/10.3.0` };
	} catch { return ANTIGRAVITY_IDENTITY; }
}

export interface AntigravityTokens {
	accessToken: string;
	refreshToken: string;
	/** Absolute expiry, derived from the response's `expires_in`. */
	expiresAt: number;
}

export interface AntigravityAccount {
	email?: string;
	/** The Cloud Code project every later request is billed against. */
	projectId: string;
	tier?: string;
}

function authorizationHeaders(accessToken: string, userAgent: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		Accept: "*/*",
		"Content-Type": "application/json",
		"User-Agent": userAgent,
	};
}

export async function failure(response: Response, what: string, secrets: readonly string[] = []): Promise<Error> {
	return new Error(formatAntigravityError(`${what} failed (HTTP ${response.status})`, await readAntigravityErrorBody(response), secrets));
}

function form(values: Record<string, string>): URLSearchParams {
	const params = new URLSearchParams(values);
	params.sort(); // Go's url.Values.Encode sorts keys.
	return params;
}

/** The consent page to send the user to. */
export function buildAuthUrl(state: string, redirectUri: string = ANTIGRAVITY_REDIRECT_URI): string {
	const params = form({
		access_type: "offline",
		client_id: ANTIGRAVITY_CLIENT_ID,
		// Consent every time: without it Google withholds the refresh token on
		// re-authorisation, and the account would silently expire in an hour.
		prompt: "consent",
		redirect_uri: redirectUri,
		response_type: "code",
		scope: ANTIGRAVITY_SCOPES.join(" "),
		state,
	});
	return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function readTokenResponse(json: unknown, previousRefresh?: string): AntigravityTokens {
	const data = (json ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	const accessToken = typeof data.access_token === "string" ? data.access_token : "";
	// A refresh response may omit the refresh token, which means "keep the one
	// you have" — dropping it would sign the user out an hour later.
	const refreshToken = typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : (previousRefresh ?? "");
	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
	if (!accessToken.trim() || !refreshToken.trim() || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new Error("Antigravity token response is missing a token");
	}
	return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export async function exchangeCode(
	code: string,
	redirectUri: string,
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<AntigravityTokens> {
	const response = await fetchImpl(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Go-http-client/1.1" },
		body: form({
			code,
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}),
	});
	if (!response.ok) throw await failure(response, "Antigravity token exchange", [code, ANTIGRAVITY_CLIENT_SECRET]);
	return readTokenResponse(await response.json());
}

export async function refreshTokens(
	refreshToken: string,
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<AntigravityTokens> {
	const response = await fetchImpl(TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": ANTIGRAVITY_REFRESH_USER_AGENT,
		},
		body: form({
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	});
	if (!response.ok) throw await failure(response, "Antigravity token refresh", [refreshToken, ANTIGRAVITY_CLIENT_SECRET]);
	return readTokenResponse(await response.json(), refreshToken);
}

export async function fetchUserEmail(
	accessToken: string,
	fetchImpl: FetchLike = globalThis.fetch,
	identity: AntigravityIdentity = ANTIGRAVITY_IDENTITY,
): Promise<string> {
	const response = await fetchImpl(USERINFO_ENDPOINT, {
		headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": identity.userAgent },
	});
	if (!response.ok) throw await failure(response, "Antigravity userinfo", [accessToken]);
	const data = (await response.json()) as { email?: unknown };
	if (typeof data.email !== "string" || !data.email.trim()) throw new Error("Antigravity userinfo returned no email");
	return data.email.trim();
}

/** The project id, under any of the names the control plane has used for it. */
export function extractProjectId(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "object" && value !== null) {
			const id = (value as { id?: unknown }).id;
			if (typeof id === "string" && id.trim()) return id.trim();
		}
	}
	return undefined;
}

/** The tier onboarding should ask for: the one marked default, else current. */
export function defaultTierId(loadResponse: unknown): string {
	const record = (loadResponse ?? {}) as Record<string, unknown>;
	const tiers = record.allowedTiers;
	if (Array.isArray(tiers)) {
		for (const entry of tiers) {
			if (typeof entry !== "object" || entry === null) continue;
			const tier = entry as { isDefault?: unknown; id?: unknown };
			if (tier.isDefault !== true) continue;
			if (typeof tier.id === "string" && tier.id.trim()) return tier.id.trim();
		}
	}
	const current = record.currentTier;
	if (typeof current === "object" && current !== null) {
		const id = (current as { id?: unknown }).id;
		if (typeof id === "string" && id.trim()) return id.trim();
	}
	return "free-tier";
}

/**
 * Register this client with Cloud Code and take the project it hands back.
 *
 * Onboarding is asynchronous: the call returns `done: false` until the project
 * exists, so it is polled — the same five attempts, two seconds apart, that the
 * reference client uses.
 */
export async function onboardUser(
	accessToken: string,
	tierId: string,
	fetchImpl: FetchLike = globalThis.fetch,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	identity: AntigravityIdentity = ANTIGRAVITY_IDENTITY,
): Promise<string> {
	const body = JSON.stringify({
		tier_id: tierId,
		metadata: { ide_type: "ANTIGRAVITY", ide_version: identity.version, ide_name: "antigravity" },
	});

	for (let attempt = 0; attempt < ONBOARD_MAX_ATTEMPTS; attempt++) {
		const response = await fetchImpl(`${DAILY_API_ENDPOINT}/${API_VERSION}:onboardUser`, {
			method: "POST",
			headers: {
				...authorizationHeaders(accessToken, identity.onboardUserAgent),
				"X-Goog-Api-Client": ANTIGRAVITY_GOOG_API_CLIENT,
			},
			body,
		});
		if (response.status !== 200) throw await failure(response, "Antigravity onboarding", [accessToken]);

		const data = (await response.json()) as { done?: unknown; response?: unknown };
		if (data.done === true) {
			const projectId = extractProjectId(data.response);
			if (projectId) return projectId;
			throw new Error("Antigravity onboarding completed without a project id");
		}
		await sleep(ONBOARD_POLL_INTERVAL_MS);
	}
	throw new Error(`Antigravity onboarding did not complete after ${ONBOARD_MAX_ATTEMPTS} attempts`);
}

/**
 * The project the account works through, onboarding it first if it has none.
 */
export async function resolveProject(
	accessToken: string,
	fetchImpl: FetchLike = globalThis.fetch,
	sleep?: (ms: number) => Promise<void>,
	identity: AntigravityIdentity = ANTIGRAVITY_IDENTITY,
): Promise<{ projectId: string; tier: string }> {
	const response = await fetchImpl(`${API_ENDPOINT}/${API_VERSION}:loadCodeAssist`, {
		method: "POST",
		headers: authorizationHeaders(accessToken, identity.userAgent),
		body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
	});
	if (!response.ok) throw await failure(response, "Antigravity loadCodeAssist", [accessToken]);

	const loaded = await response.json();
	const tier = defaultTierId(loaded);
	const existing = extractProjectId(loaded);
	if (existing) return { projectId: existing, tier };
	return { projectId: await onboardUser(accessToken, tier, fetchImpl, sleep, identity), tier };
}
