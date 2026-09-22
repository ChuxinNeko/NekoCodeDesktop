import type { FetchedModel, ModelApiProtocol } from "../shared/settings";
import { PROTOCOL_SUFFIX } from "../shared/model-protocol";

export { PROTOCOL_SUFFIX };

/**
 * How much of the endpoint the vendor SDK builds for itself, and so must not
 * appear in the base URL we hand it. The OpenAI client appends only the leaf,
 * but the Anthropic client hardcodes `/v1/messages` — leaving the `/v1` on its
 * base URL makes it request `/v1/v1/messages`.
 */
const SDK_PATH_SUFFIX: Record<ModelApiProtocol, string> = {
	...PROTOCOL_SUFFIX,
	"anthropic-messages": "/v1/messages",
};

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function validateBaseUrl(raw: string): string {
	const trimmed = raw.trim();
	if (CONTROL_CHARS.test(trimmed)) {
		throw new Error("Base URL must not contain control characters");
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid base URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Base URL must be http or https: ${raw}`);
	}
	if (url.username || url.password) {
		throw new Error("Base URL must not contain credentials");
	}
	if (url.search || url.hash) {
		throw new Error("Base URL must not contain query or hash");
	}
	return trimmed.replace(/\/+$/, "");
}

export function validateRoute(route: string): string {
	const trimmed = route.trim();
	if (!trimmed.startsWith("/")) {
		throw new Error(`Route must start with /: ${route}`);
	}
	if (trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error("Route must not contain query or hash");
	}
	if (trimmed.includes("\\") || CONTROL_CHARS.test(trimmed)) {
		throw new Error("Route contains invalid characters");
	}
	for (const segment of trimmed.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			throw new Error("Route contains invalid encoding");
		}
		if (decoded === "..") {
			throw new Error("Route must not contain .. segments");
		}
	}
	return trimmed.replace(/\/+$/, "") || "/";
}

function requireSuffix(route: string, api: ModelApiProtocol): void {
	const suffix = PROTOCOL_SUFFIX[api];
	if (!route.endsWith(suffix)) {
		throw new Error(`Route for ${api} must end with ${suffix}`);
	}
}

/** Join base URL and route, tolerating slashes on either side. */
export function joinEndpoint(baseUrl: string, route: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	const path = route.startsWith("/") ? route : `/${route}`;
	return `${base}${path}`;
}

/**
 * Validate base URL + route + protocol and derive the endpoint, SDK base URL,
 * and models URL. The route must end with the protocol's required suffix.
 */
export function resolveEndpoints(
	baseUrl: string,
	route: string,
	api: ModelApiProtocol,
): { endpoint: string; sdkBaseUrl: string; modelsUrl: string } {
	if (!(api in PROTOCOL_SUFFIX)) {
		throw new Error(`Unknown API protocol: ${String(api)}`);
	}
	const base = validateBaseUrl(baseUrl);
	const path = validateRoute(route);
	requireSuffix(path, api);
	const endpoint = joinEndpoint(base, path);
	const suffix = PROTOCOL_SUFFIX[api];
	// `/models` is a sibling of the endpoint's leaf, under the same API root.
	const apiRoot = endpoint.slice(0, endpoint.length - suffix.length);
	// A route that stops short of the SDK's own suffix — `/messages` without the
	// `/v1` — is unreachable through the SDK either way, so fall back to the root
	// rather than cutting a suffix the endpoint does not carry.
	const sdkSuffix = SDK_PATH_SUFFIX[api];
	const sdkBaseUrl = endpoint.endsWith(sdkSuffix)
		? endpoint.slice(0, endpoint.length - sdkSuffix.length)
		: apiRoot;
	const modelsUrl = `${apiRoot.replace(/\/+$/, "")}/models`;
	return { endpoint, sdkBaseUrl, modelsUrl };
}

/** Authoritative request headers for GET {modelsUrl}. */
export function buildModelsHeaders(
	api: ModelApiProtocol,
	apiKey: string,
): Record<string, string> {
	if (api === "anthropic-messages") {
		return {
			Accept: "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		};
	}
	return {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
}

interface ModelsListEntry {
	id?: unknown;
	name?: unknown;
	display_name?: unknown;
}

/** Parse a models-list response: top-level `data` array (or `models`). */
export function parseModelsJson(json: unknown): FetchedModel[] {
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new Error("Unexpected models response shape");
	}
	const root = json as { data?: unknown; models?: unknown };
	const list = Array.isArray(root.data)
		? root.data
		: Array.isArray(root.models)
			? root.models
			: null;
	if (!list) {
		throw new Error("Unexpected models response shape");
	}
	const seen = new Map<string, string>();
	for (const item of list) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as ModelsListEntry;
		if (typeof entry.id !== "string" || entry.id.trim() === "") continue;
		const id = entry.id.trim();
		const name =
			typeof entry.name === "string" && entry.name.trim()
				? entry.name.trim()
				: typeof entry.display_name === "string" && entry.display_name.trim()
					? entry.display_name.trim()
					: id;
		if (!seen.has(id)) seen.set(id, name);
	}
	return [...seen.entries()]
		.map(([id, name]) => ({ id, name }))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
