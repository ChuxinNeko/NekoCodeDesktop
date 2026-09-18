import { describe, expect, test } from "bun:test";
import {
	CODEX_CLIENT_HEADERS,
	CODEX_ORIGINATOR,
	CODEX_USER_AGENT,
	readCodexClaims,
} from "./openai-codex";

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

describe("codex client identity", () => {
	// Pinned on purpose: these are the values CLIProxyAPI presents to the same
	// endpoint. A drift here is a behaviour change upstream sees, not a cleanup.
	test("presents the Codex CLI identity CLIProxyAPI does", () => {
		expect(CODEX_USER_AGENT).toBe(
			"codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)",
		);
		expect(CODEX_ORIGINATOR).toBe("codex-tui");
		expect(CODEX_CLIENT_HEADERS).toEqual({
			"User-Agent": CODEX_USER_AGENT,
			originator: CODEX_ORIGINATOR,
		});
	});
});

describe("readCodexClaims", () => {
	test("reads the account the token belongs to", () => {
		const token = jwt({
			email: "someone@example.com",
			exp: 1_700_000_000,
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acc_123",
				chatgpt_plan_type: "pro",
			},
		});

		expect(readCodexClaims(token)).toEqual({
			accountId: "acc_123",
			plan: "pro",
			email: "someone@example.com",
			expiresAt: 1_700_000_000_000,
		});
	});

	test("a token without account claims yields nothing rather than throwing", () => {
		expect(readCodexClaims(jwt({ sub: "user_1" }))).toEqual({});
	});

	test("anything that is not a readable JWT is simply unknown", () => {
		// The token still works; only the row that names the account goes blank.
		expect(readCodexClaims("not-a-token")).toEqual({});
		expect(readCodexClaims("a.b.c")).toEqual({});
		expect(readCodexClaims("")).toEqual({});
	});
});
