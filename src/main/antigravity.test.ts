import { describe, expect, test } from "bun:test";
import {
	ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_REDIRECT_URI,
	ANTIGRAVITY_SCOPES, ANTIGRAVITY_USER_AGENT, ANTIGRAVITY_ONBOARD_USER_AGENT,
	buildAuthUrl, exchangeCode, refreshTokens, fetchUserEmail, resolveProject,
	fetchAntigravityIdentity, type FetchLike,
} from "./antigravity";

function responses(...values: unknown[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url: String(url), init });
		if (!values.length) throw new Error("Unexpected network request");
		const value = values.shift();
		return value instanceof Response ? value : Response.json(value);
	};
	return { calls, fetch };
}

describe("CLIProxyAPI Antigravity OAuth protocol", () => {
	test("consent URL uses the exact client, scopes, callback and no PKCE additions", () => {
		expect(ANTIGRAVITY_CLIENT_ID).toBe("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
		expect(ANTIGRAVITY_CLIENT_SECRET).toBe("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");
		const url = new URL(buildAuthUrl("state-123"));
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			access_type: "offline", client_id: ANTIGRAVITY_CLIENT_ID, prompt: "consent",
			redirect_uri: "http://localhost:51121/oauth-callback", response_type: "code",
			scope: ANTIGRAVITY_SCOPES.join(" "), state: "state-123",
		});
		expect(ANTIGRAVITY_SCOPES).toEqual([
			"https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
		]);
	});

	test("code exchange is a sorted form; no JSON, extra scopes, or code verifier", async () => {
		const mock = responses({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		const before = Date.now();
		const tokens = await exchangeCode("a+b/code", ANTIGRAVITY_REDIRECT_URI, mock.fetch);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
		expect(mock.calls[0]!.init?.method).toBe("POST");
		expect(mock.calls[0]!.init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Go-http-client/1.1" });
		expect(String(mock.calls[0]!.init?.body)).toBe(new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET,
			code: "a+b/code", grant_type: "authorization_code", redirect_uri: ANTIGRAVITY_REDIRECT_URI,
		}).toString());
		expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
	});

	test("refresh pins the reference UA and preserves an omitted refresh token", async () => {
		const mock = responses({ access_token: "new", expires_in: 3600 });
		expect(await refreshTokens("old-refresh", mock.fetch)).toMatchObject({ accessToken: "new", refreshToken: "old-refresh" });
		expect(mock.calls[0]!.init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Go-http-client/2.0" });
		expect(Object.fromEntries(mock.calls[0]!.init?.body as URLSearchParams)).toEqual({
			client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET,
			grant_type: "refresh_token", refresh_token: "old-refresh",
		});
	});

	test("userinfo and project discovery use their exact endpoints and metadata", async () => {
		const mock = responses({ email: " person@example.com " }, { cloudaicompanionProject: { id: "project-1" } });
		expect(await fetchUserEmail("token", mock.fetch)).toBe("person@example.com");
		expect(await resolveProject("token", mock.fetch)).toMatchObject({ projectId: "project-1" });
		expect(mock.calls.map((call) => call.url)).toEqual([
			"https://www.googleapis.com/oauth2/v2/userinfo?alt=json", "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
		]);
		expect(mock.calls[0]!.init?.headers).toEqual({ Authorization: "Bearer token", "User-Agent": ANTIGRAVITY_USER_AGENT });
		expect(mock.calls[1]!.init?.headers).toEqual({ Authorization: "Bearer token", Accept: "*/*", "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_USER_AGENT });
		expect(JSON.parse(String(mock.calls[1]!.init?.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
	});

	test("onboarding selects the default tier and polls daily with the long UA", async () => {
		const mock = responses(
			{ allowedTiers: [{ id: "paid", isDefault: true }], currentTier: { id: "free" } },
			{ done: false }, { done: true, response: { projectId: "assigned" } },
		);
		const waits: number[] = [];
		expect(await resolveProject("token", mock.fetch, async (ms) => { waits.push(ms); })).toEqual({ projectId: "assigned", tier: "paid" });
		expect(waits).toEqual([2000]);
		for (const call of mock.calls.slice(1)) {
			expect(call.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser");
			expect(call.init?.headers).toEqual({ Authorization: "Bearer token", Accept: "*/*", "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_ONBOARD_USER_AGENT, "X-Goog-Api-Client": "gl-node/22.21.1" });
			expect(JSON.parse(String(call.init?.body))).toEqual({ tier_id: "paid", metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.9.1", ide_name: "antigravity" } });
		}
	});

	test("polling is bounded to five attempts, without endpoint fallback", async () => {
		const mock = responses({}, ...Array.from({ length: 5 }, () => ({ done: false })));
		await expect(resolveProject("token", mock.fetch, async () => {})).rejects.toThrow("5 attempts");
		expect(mock.calls).toHaveLength(6);
	});

	test("missing identity, project or tokens fails; upstream secrets stay out of errors", async () => {
		await expect(fetchUserEmail("token", responses({}).fetch)).rejects.toThrow("no email");
		await expect(exchangeCode("code", ANTIGRAVITY_REDIRECT_URI, responses({ access_token: "access", expires_in: 3600 }).fetch)).rejects.toThrow("missing");
		await expect(resolveProject("token", responses({}, { done: true, response: {} }).fetch, async () => {})).rejects.toThrow("without a project");
		const mock = responses(new Response("access_token=DO-NOT-LEAK", { status: 403 }));
		await expect(resolveProject("token", mock.fetch)).rejects.toThrow("HTTP 403");
		expect(mock.calls).toHaveLength(1);
	});

	test("Hub manifest uses reference headers and falls back on invalid data", async () => {
		const mock = responses(new Response("version: 2.10.0\nfiles: []"));
		expect(await fetchAntigravityIdentity(mock.fetch)).toEqual({
			version: "2.10.0", userAgent: "antigravity/hub/2.10.0 darwin/arm64",
			onboardUserAgent: "antigravity/hub/2.10.0 darwin/arm64 google-api-nodejs-client/10.3.0",
		});
		expect(mock.calls[0]!.init?.headers).toEqual({ "User-Agent": "electron-builder", "Cache-Control": "no-cache" });
		expect((await fetchAntigravityIdentity(responses(new Response("version: malicious/value")).fetch)).version).toBe("2.9.1");
	});
});
