import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	MAX_CONTEXT_WINDOW,
	MAX_OUTPUT_TOKENS,
	MIN_TOKEN_LIMIT,
	type ModelApiProtocol,
	type ModelProfileSummary,
	type ModelTokenLimits,
	type ProviderKind,
} from "../shared/settings";
import { resolveEndpoints } from "./model-endpoint";

export const MAX_PROFILES = 100;
export const MAX_MODELS = 500;
export const MAX_NAME = 120;
export const MAX_URL = 500;
export const MAX_MODEL_ID = 200;
export const MAX_ENCRYPTED_KEY = 64 * 1024;
export const API_PROTOCOLS: ModelApiProtocol[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
];
export const PROVIDER_KINDS: ProviderKind[] = ["custom-api", "oauth"];
/** What a profile written before provider types existed has to be. */
export const DEFAULT_PROVIDER_KIND: ProviderKind = "custom-api";

// The token limits live in the shared contract: the provider form edits them.
export {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	MAX_CONTEXT_WINDOW,
	MAX_OUTPUT_TOKENS,
	MIN_TOKEN_LIMIT,
};

const SHAPE_ERROR =
	"model-profiles.json has an unexpected shape and will not be overwritten";

export interface StoredProfile {
	id: string;
	/** Optional: profiles written before provider types existed are custom API. */
	kind?: ProviderKind;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	encryptedApiKey: string;
	modelIds: string[];
	/** Optional: profiles written before the flag existed count as non-reasoning. */
	reasoning?: boolean;
	/** Optional overrides; absent means the conservative defaults above. */
	contextWindow?: number;
	maxTokens?: number;
	/** Optional per-model ceilings; a missing key inherits the profile values. */
	modelOverrides?: Record<string, ModelTokenLimits>;
	createdAt: number;
	updatedAt: number;
}

export interface ProfileFile {
	version: 1;
	profiles: StoredProfile[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && !Array.isArray(value)
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** An absent limit is the default; a present one has to be a usable integer. */
export function isValidTokenLimit(value: unknown, max: number): boolean {
	return (
		value === undefined ||
		(typeof value === "number" &&
			Number.isInteger(value) &&
			value >= MIN_TOKEN_LIMIT &&
			value <= max)
	);
}

/**
 * Both limits are required inside an override — unlike the profile-level
 * fields, a half-written override cannot lean on "absent means default".
 */
export function isValidModelOverrides(value: unknown): value is Record<string, ModelTokenLimits> {
	if (value === undefined) return true;
	if (!isPlainObject(value)) return false;
	const entries = Object.entries(value);
	if (entries.length > MAX_MODELS) return false;
	return entries.every(
		([modelId, limits]) =>
			isNonEmptyString(modelId) &&
			modelId.length <= MAX_MODEL_ID &&
			isPlainObject(limits) &&
			typeof limits.contextWindow === "number" &&
			Number.isInteger(limits.contextWindow) &&
			limits.contextWindow >= MIN_TOKEN_LIMIT &&
			limits.contextWindow <= MAX_CONTEXT_WINDOW &&
			typeof limits.maxTokens === "number" &&
			Number.isInteger(limits.maxTokens) &&
			limits.maxTokens >= MIN_TOKEN_LIMIT &&
			limits.maxTokens <= MAX_OUTPUT_TOKENS,
	);
}

/**
 * Validate a parsed profile file. Throws the uniform shape error on any bad
 * field so a corrupt file is never partially loaded or overwritten.
 */
export function validateProfileFile(parsed: unknown): StoredProfile[] {
	if (!isPlainObject(parsed) || parsed.version !== 1) {
		throw new Error(SHAPE_ERROR);
	}
	if (!Array.isArray(parsed.profiles) || parsed.profiles.length > MAX_PROFILES) {
		throw new Error(SHAPE_ERROR);
	}
	const ids = new Set<string>();
	for (const item of parsed.profiles) {
		if (!isPlainObject(item)) throw new Error(SHAPE_ERROR);
		const p = item as Record<string, unknown>;
		if (
			!isNonEmptyString(p.id) ||
			!isNonEmptyString(p.name) ||
			!isNonEmptyString(p.baseUrl) ||
			!isNonEmptyString(p.route) ||
			!isNonEmptyString(p.encryptedApiKey)
		) {
			throw new Error(SHAPE_ERROR);
		}
		if (
			(p.name as string).length > MAX_NAME ||
			(p.baseUrl as string).length > MAX_URL ||
			(p.route as string).length > MAX_URL ||
			(p.encryptedApiKey as string).length > MAX_ENCRYPTED_KEY
		) {
			throw new Error(SHAPE_ERROR);
		}
		if (ids.has(p.id as string)) throw new Error(SHAPE_ERROR);
		ids.add(p.id as string);
		if (!API_PROTOCOLS.includes(p.api as ModelApiProtocol)) {
			throw new Error(SHAPE_ERROR);
		}
		// An empty list is valid: a provider is stored as soon as its endpoint and
		// key are known, and its models are picked from that endpoint afterwards.
		if (
			!Array.isArray(p.modelIds) ||
			p.modelIds.length > MAX_MODELS ||
			!p.modelIds.every(
				(m) => isNonEmptyString(m) && m.length <= MAX_MODEL_ID,
			)
		) {
			throw new Error(SHAPE_ERROR);
		}
		if (p.reasoning !== undefined && typeof p.reasoning !== "boolean") {
			throw new Error(SHAPE_ERROR);
		}
		if (
			!isValidTokenLimit(p.contextWindow, MAX_CONTEXT_WINDOW) ||
			!isValidTokenLimit(p.maxTokens, MAX_OUTPUT_TOKENS)
		) {
			throw new Error(SHAPE_ERROR);
		}
		if (
			!isValidModelOverrides(p.modelOverrides) ||
			(p.modelOverrides !== undefined &&
				!Object.keys(p.modelOverrides).every((id) =>
					(p.modelIds as string[]).includes(id),
				))
		) {
			throw new Error(SHAPE_ERROR);
		}
		if (
			p.kind !== undefined &&
			!PROVIDER_KINDS.includes(p.kind as ProviderKind)
		) {
			throw new Error(SHAPE_ERROR);
		}
		if (
			typeof p.createdAt !== "number" ||
			!Number.isFinite(p.createdAt) ||
			typeof p.updatedAt !== "number" ||
			!Number.isFinite(p.updatedAt)
		) {
			throw new Error(SHAPE_ERROR);
		}
		try {
			resolveEndpoints(
				p.baseUrl as string,
				p.route as string,
				p.api as ModelApiProtocol,
			);
		} catch {
			throw new Error(SHAPE_ERROR);
		}
	}
	return parsed.profiles as StoredProfile[];
}

export function toSummary(p: StoredProfile): ModelProfileSummary {
	return {
		id: p.id,
		kind: p.kind ?? DEFAULT_PROVIDER_KIND,
		name: p.name,
		baseUrl: p.baseUrl,
		route: p.route,
		api: p.api,
		modelIds: [...p.modelIds],
		reasoning: p.reasoning === true,
		contextWindow: p.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: p.maxTokens ?? DEFAULT_MAX_TOKENS,
		modelOverrides: Object.fromEntries(
			Object.entries(p.modelOverrides ?? {}).map(([id, limits]) => [id, { ...limits }]),
		),
		hasApiKey: p.encryptedApiKey.length > 0,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
	};
}
