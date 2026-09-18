/**
 * Client identity and token reading for the ChatGPT Codex backend.
 *
 * `https://chatgpt.com/backend-api/codex` is the Codex CLI's own endpoint, not a
 * public API: what it sees of the client is part of how the account behind the
 * token is treated. So the identity presented here is pinned to the pair
 * CLIProxyAPI presents (`internal/runtime/executor/codex_executor_request.go`,
 * `codexUserAgent` / `codexOriginator`) rather than left to whatever the agent
 * core defaults to. Do not "modernize" these strings — they are a wire format,
 * and drifting from a known-good client is exactly what gets an account flagged.
 */
export const CODEX_USER_AGENT =
	"codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)";

export const CODEX_ORIGINATOR = "codex-tui";

/**
 * Headers registered onto the agent core's `openai-codex` provider. The core
 * already sends Authorization, chatgpt-account-id, session-id, accept and
 * content-type the same way CLIProxyAPI does; these two are the ones it would
 * otherwise fill with its own identity.
 *
 * `Connection: Keep-Alive` is deliberately absent even though CLIProxyAPI sets
 * it: fetch/undici owns connection reuse and refuses the header.
 */
export const CODEX_CLIENT_HEADERS: Record<string, string> = {
	"User-Agent": CODEX_USER_AGENT,
	originator: CODEX_ORIGINATOR,
};

/** The claim object OpenAI hangs ChatGPT account details off of. */
const AUTH_CLAIM = "https://api.openai.com/auth";

export interface CodexTokenClaims {
	accountId?: string;
	email?: string;
	/** "plus", "pro", "team", "free", … as reported by the token. */
	plan?: string;
	expiresAt?: number;
}

function decodeSegment(segment: string): unknown {
	// JWT payloads are base64url without padding.
	return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Read the non-secret account details out of a Codex access token.
 *
 * The token is a JWT the app never verifies — the issuer already did, and this
 * only feeds the settings row that names which account is signed in. Anything
 * missing simply stays undefined.
 */
export function readCodexClaims(accessToken: string): CodexTokenClaims {
	const parts = accessToken.split(".");
	if (parts.length !== 3 || !parts[1]) return {};
	let payload: unknown;
	try {
		payload = decodeSegment(parts[1]);
	} catch {
		return {};
	}
	if (typeof payload !== "object" || payload === null) return {};
	const root = payload as Record<string, unknown>;
	const auth = root[AUTH_CLAIM];
	const authInfo = typeof auth === "object" && auth !== null ? (auth as Record<string, unknown>) : {};
	const accountId = authInfo.chatgpt_account_id;
	const plan = authInfo.chatgpt_plan_type;
	const email = root.email;
	const exp = root.exp;
	return {
		...(typeof accountId === "string" && accountId ? { accountId } : {}),
		...(typeof plan === "string" && plan ? { plan } : {}),
		...(typeof email === "string" && email ? { email } : {}),
		...(typeof exp === "number" && Number.isFinite(exp) ? { expiresAt: exp * 1000 } : {}),
	};
}
