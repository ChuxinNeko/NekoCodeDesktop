import type {
	ModelApiProtocol,
	ModelProfileSummary,
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

const SHAPE_ERROR =
	"model-profiles.json has an unexpected shape and will not be overwritten";

export interface StoredProfile {
	id: string;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	encryptedApiKey: string;
	modelIds: string[];
	/** Optional: profiles written before the flag existed count as non-reasoning. */
	reasoning?: boolean;
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
		if (
			!Array.isArray(p.modelIds) ||
			p.modelIds.length === 0 ||
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
		name: p.name,
		baseUrl: p.baseUrl,
		route: p.route,
		api: p.api,
		modelIds: [...p.modelIds],
		reasoning: p.reasoning === true,
		hasApiKey: p.encryptedApiKey.length > 0,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
	};
}
