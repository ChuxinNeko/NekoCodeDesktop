import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, safeStorage } from "electron";
import type {
	FetchModelsRequest,
	FetchedModel,
	ModelApiProtocol,
	ModelProfileSummary,
	ModelStoreStatus,
	SaveModelProfileRequest,
} from "../shared/settings";
import {
	buildModelsHeaders,
	parseModelsJson,
	resolveEndpoints,
} from "./model-endpoint";
import {
	API_PROTOCOLS,
	MAX_MODEL_ID,
	MAX_MODELS,
	MAX_NAME,
	MAX_PROFILES,
	MAX_URL,
	toSummary,
	validateProfileFile,
	type ProfileFile,
	type StoredProfile,
} from "./model-config-store";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BODY = 500;
const FETCH_TIMEOUT_MS = 20_000;

/** Decrypted profile for main-process registration into pi ModelRuntime. */
export interface RegistrationProfile {
	providerId: string;
	name: string;
	sdkBaseUrl: string;
	api: ModelApiProtocol;
	apiKey: string;
	modelIds: string[];
}

export class ModelConfigService {
	private filePath: string;
	private profiles: StoredProfile[] | null = null;

	constructor() {
		const dir = app.getPath("userData");
		mkdirSync(dir, { recursive: true });
		this.filePath = join(dir, "model-profiles.json");
	}

	private load(): StoredProfile[] {
		if (this.profiles) return this.profiles;
		if (!existsSync(this.filePath)) {
			this.profiles = [];
			return this.profiles;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
		} catch (error) {
			throw new Error(
				`model-profiles.json is corrupted and will not be overwritten: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		this.profiles = validateProfileFile(parsed);
		return this.profiles;
	}

	/** Atomically write the candidate list; on success swap it in. */
	private persist(candidate: StoredProfile[]): void {
		const file: ProfileFile = { version: 1, profiles: candidate };
		const tmp = `${this.filePath}.tmp-${process.pid}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
				mode: 0o600,
			});
			renameSync(tmp, this.filePath);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// best-effort cleanup of our own temp file
			}
			throw error;
		}
		this.profiles = candidate;
	}

	status(): ModelStoreStatus {
		let backend = "unknown";
		try {
			backend = safeStorage.getSelectedStorageBackend();
		} catch {
			// older Electron without backend introspection
		}
		const encryptionAvailable = safeStorage.isEncryptionAvailable();
		const warning =
			backend === "basic_text"
				? "系统密钥环不可用，当前后端保护较弱 (safeStorage basic_text)"
				: undefined;
		return { encryptionAvailable, backend, warning };
	}

	list(): ModelProfileSummary[] {
		return this.load().map(toSummary);
	}

	save(req: SaveModelProfileRequest): ModelProfileSummary {
		const profiles = this.load();
		const name = req.name.trim();
		if (!name) throw new Error("配置名称不能为空");
		if (name.length > MAX_NAME) throw new Error("配置名称过长");
		if (!API_PROTOCOLS.includes(req.api)) {
			throw new Error(`Unknown API protocol: ${String(req.api)}`);
		}
		// Validates base URL, route, and the protocol suffix in one pass.
		resolveEndpoints(req.baseUrl, req.route, req.api);
		const baseUrl = req.baseUrl.trim();
		const route = req.route.trim();
		if (baseUrl.length > MAX_URL || route.length > MAX_URL) {
			throw new Error("URL/route too long");
		}
		const modelIds = [
			...new Set(req.modelIds.map((m) => m.trim()).filter(Boolean)),
		];
		if (modelIds.length === 0) throw new Error("至少需要一个模型");
		if (modelIds.length > MAX_MODELS) throw new Error("模型数量过多");
		for (const id of modelIds) {
			if (id.length > MAX_MODEL_ID) throw new Error(`Model id too long: ${id}`);
		}

		const existing = req.id ? profiles.find((p) => p.id === req.id) : undefined;
		if (req.id && !existing) throw new Error("Profile not found");
		if (!existing && profiles.length >= MAX_PROFILES) {
			throw new Error("Profile limit reached");
		}

		const submittedKey = req.apiKey?.trim() ?? "";
		let encryptedApiKey: string;
		if (submittedKey) {
			if (!safeStorage.isEncryptionAvailable()) {
				throw new Error("系统密钥环不可用，无法安全保存 API Key");
			}
			encryptedApiKey = safeStorage
				.encryptString(submittedKey)
				.toString("base64");
		} else if (existing) {
			encryptedApiKey = existing.encryptedApiKey;
		} else {
			throw new Error("新建配置需要 API Key");
		}

		const now = Date.now();
		const record: StoredProfile = existing
			? {
					...existing,
					name,
					baseUrl,
					route,
					api: req.api,
					encryptedApiKey,
					modelIds,
					updatedAt: now,
				}
			: {
					id: randomUUID(),
					name,
					baseUrl,
					route,
					api: req.api,
					encryptedApiKey,
					modelIds,
					createdAt: now,
					updatedAt: now,
				};
		const candidate = existing
			? profiles.map((p) => (p === existing ? record : p))
			: [...profiles, record];
		this.persist(candidate);
		return toSummary(record);
	}

	delete(id: string): void {
		const profiles = this.load();
		const index = profiles.findIndex((p) => p.id === id);
		if (index === -1) throw new Error("Profile not found");
		this.persist(profiles.filter((_, i) => i !== index));
	}

	private decryptApiKey(profile: StoredProfile): string {
		try {
			return safeStorage
				.decryptString(
					Buffer.from(profile.encryptedApiKey, "base64"),
				)
				.trim();
		} catch {
			throw new Error(`无法解密 ${profile.name} 的 API Key`);
		}
	}

	async fetchModels(req: FetchModelsRequest): Promise<FetchedModel[]> {
		let apiKey = req.apiKey?.trim() ?? "";
		if (!apiKey && req.profileId) {
			const profile = this.load().find((p) => p.id === req.profileId);
			if (!profile) throw new Error("Profile not found");
			apiKey = this.decryptApiKey(profile);
		}
		if (!apiKey) throw new Error("需要 API Key 才能获取模型列表");
		if (!API_PROTOCOLS.includes(req.api)) {
			throw new Error(`Unknown API protocol: ${String(req.api)}`);
		}
		const { modelsUrl } = resolveEndpoints(req.baseUrl, req.route, req.api);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(modelsUrl, {
				method: "GET",
				headers: buildModelsHeaders(req.api, apiKey),
				signal: controller.signal,
			});
			const lengthHeader = response.headers.get("content-length");
			if (lengthHeader !== null) {
				const declared = Number(lengthHeader);
				if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
					throw new Error("Models response too large");
				}
			}
			const text = await response.text();
			if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
				throw new Error("Models response too large");
			}
			if (!response.ok) {
				throw new Error(
					`HTTP ${response.status}: ${text.slice(0, MAX_ERROR_BODY)}`,
				);
			}
			return parseModelsJson(JSON.parse(text));
		} finally {
			clearTimeout(timer);
		}
	}

	/** Main-process only: decrypted credentials for pi provider registration. */
	registrationProfiles(): RegistrationProfile[] {
		return this.load().map((p) => {
			const { sdkBaseUrl } = resolveEndpoints(p.baseUrl, p.route, p.api);
			return {
				providerId: `nekocode-${p.id}`,
				name: p.name,
				sdkBaseUrl,
				api: p.api,
				apiKey: this.decryptApiKey(p),
				modelIds: [...p.modelIds],
			};
		});
	}
}
