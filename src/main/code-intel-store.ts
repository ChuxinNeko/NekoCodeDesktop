import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeIntelStatus, CodeIntelUpdate } from "../shared/code-intel";

const FILE = "code-intel.json";

/** A model key from IPC: `provider/model`, or null for none. */
function modelKey(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !value.includes("/") || value.length > 400) throw new Error("Not a model key");
	return value;
}

function readKey(value: unknown): string | null {
	try {
		return modelKey(value ?? null);
	} catch {
		return null;
	}
}

/**
 * Code intelligence settings: whether the index is on, and which models from
 * Settings → Providers and models it and Tab completion use. No addresses or
 * keys of its own — those stay with the provider they belong to.
 */
export class CodeIntelStore {
	private readonly path: string;
	private file: CodeIntelStatus | null = null;

	constructor(private readonly userDataDir: string) {
		this.path = join(userDataDir, FILE);
	}

	status(): CodeIntelStatus {
		if (this.file) return this.file;
		let parsed: Record<string, unknown> = {};
		if (existsSync(this.path)) {
			try {
				const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
				if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
			} catch {
				// Corrupt: defaults, and the next save replaces it.
			}
		}
		const completion = (parsed.completion ?? {}) as Record<string, unknown>;
		const prediction = (parsed.prediction ?? {}) as Record<string, unknown>;
		this.file = {
			prediction: { enabled: prediction.enabled === true, modelKey: readKey(prediction.modelKey) },
			indexEnabled: typeof parsed.indexEnabled === "boolean" ? parsed.indexEnabled : true,
			searchModel: readKey(parsed.searchModel),
			completion: {
				enabled: typeof completion.enabled === "boolean" ? completion.enabled : false,
				modelKey: readKey(completion.modelKey),
			},
		};
		return this.file;
	}

	/** Apply a change from the settings page. It arrives over IPC, so each field is checked. */
	update(patch: CodeIntelUpdate): CodeIntelStatus {
		const current = this.status();
		const next: CodeIntelStatus = { ...current, completion: { ...current.completion }, prediction: { ...current.prediction } };
		if (typeof patch.prediction?.enabled === "boolean") next.prediction.enabled = patch.prediction.enabled;
		if (patch.prediction?.modelKey !== undefined) next.prediction.modelKey = modelKey(patch.prediction.modelKey);
		if (typeof patch.indexEnabled === "boolean") next.indexEnabled = patch.indexEnabled;
		if (patch.searchModel !== undefined) next.searchModel = modelKey(patch.searchModel);
		if (typeof patch.completion?.enabled === "boolean") next.completion.enabled = patch.completion.enabled;
		if (patch.completion?.modelKey !== undefined) next.completion.modelKey = modelKey(patch.completion.modelKey);
		mkdirSync(this.userDataDir, { recursive: true });
		const temporary = `${this.path}.tmp-${process.pid}`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next }, null, "\t")}\n`);
			renameSync(temporary, this.path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		this.file = next;
		return next;
	}
}
