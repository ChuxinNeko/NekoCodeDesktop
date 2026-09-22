import type { ModelApiProtocol } from "./settings";

/**
 * What each protocol's endpoint path ends with.
 *
 * Shared rather than owned by the backend, because the settings form derives
 * the same thing from a pasted URL. Two copies of this drifting apart is how an
 * endpoint ends up validated against one protocol and called as another.
 */
export const PROTOCOL_SUFFIX: Record<ModelApiProtocol, string> = {
	"openai-completions": "/chat/completions",
	"openai-responses": "/responses",
	"anthropic-messages": "/messages",
};

/** The route a freshly picked protocol starts from. */
export const PROTOCOL_DEFAULT_ROUTE: Record<ModelApiProtocol, string> = {
	"openai-completions": "/v1/chat/completions",
	"openai-responses": "/v1/responses",
	"anthropic-messages": "/v1/messages",
};

/**
 * Which API shape a path speaks, or null when it is none of them.
 *
 * Every protocol ends its path differently, which is what makes a complete URL
 * enough on its own — the user pastes one address instead of splitting it into
 * a base and a route and picking the protocol by hand.
 */
export function protocolForRoute(route: string): ModelApiProtocol | null {
	let match: ModelApiProtocol | null = null;
	for (const [api, suffix] of Object.entries(PROTOCOL_SUFFIX) as [ModelApiProtocol, string][]) {
		if (!route.endsWith(suffix)) continue;
		// Longest wins, so a suffix that contains another cannot shadow it.
		if (match === null || suffix.length > PROTOCOL_SUFFIX[match].length) match = api;
	}
	return match;
}

export interface ParsedEndpoint {
	/** Scheme, host and port — what the base URL field would hold. */
	baseUrl: string;
	/** The whole path, which for a custom deployment is rarely the default one. */
	route: string;
	api: ModelApiProtocol;
}

/**
 * Split one complete endpoint URL into the base, route and protocol the backend
 * stores. Null when it is not a usable endpoint — the form says so rather than
 * saving something that would fail at request time.
 */
export function parseFullEndpoint(value: string): ParsedEndpoint | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	// The backend rejects all of these too; catching them here names the problem
	// while the field is still in front of the user.
	if (url.username || url.password || url.search || url.hash) return null;
	const route = url.pathname.replace(/\/+$/, "");
	const api = protocolForRoute(route);
	if (!api) return null;
	return { baseUrl: url.origin, route, api };
}
