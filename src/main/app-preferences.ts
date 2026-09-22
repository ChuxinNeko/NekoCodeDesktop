import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APP_PREFERENCES, type AppPreferences } from "../shared/preferences";

/** Not `preferences.json`: AgentService has owned that file since before this. */
const FILE = "app-preferences.json";

/**
 * The main process's own preferences, in one small JSON file.
 *
 * Read through defaults rather than trusted as written: the file is editable by
 * hand and survives downgrades, so a missing or mistyped key falls back instead
 * of turning into `undefined` somewhere that expects a boolean.
 */
export class AppPreferencesStore {
	private readonly path: string;
	private cached: AppPreferences | null = null;

	constructor(userDataDir: string) {
		mkdirSync(userDataDir, { recursive: true });
		this.path = join(userDataDir, FILE);
	}

	get(): AppPreferences {
		if (this.cached) return this.cached;
		this.cached = { ...DEFAULT_APP_PREFERENCES, ...this.read() };
		return this.cached;
	}

	private read(): Partial<AppPreferences> {
		if (!existsSync(this.path)) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			const source = parsed as Record<string, unknown>;
			const result: Partial<AppPreferences> = {};
			for (const key of Object.keys(DEFAULT_APP_PREFERENCES) as (keyof AppPreferences)[]) {
				if (typeof source[key] === "boolean") result[key] = source[key];
			}
			return result;
		} catch {
			// A corrupt file is not worth failing startup over — defaults, and the
			// next write replaces it.
			return {};
		}
	}

	update(patch: Partial<AppPreferences>): AppPreferences {
		const next = { ...this.get(), ...patch };
		this.cached = next;
		// Written through a temporary file: a half-flushed preferences.json would
		// be read back as corrupt on the next launch and silently reset.
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
		renameSync(temporary, this.path);
		return next;
	}
}
