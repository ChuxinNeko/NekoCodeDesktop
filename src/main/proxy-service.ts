import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProxyStatus } from "../shared/settings";
import { applyProxy, resolveProxy } from "./network-proxy";

/**
 * A host the app must be able to reach for the proxy question to matter. The
 * resolution is per-URL — a system proxy can route one host and not another —
 * so it is asked about the endpoint that actually fails without a proxy.
 */
const PROBE_URL = "https://chatgpt.com/backend-api/codex/responses";

interface StoredSettings {
	/** Absent = follow the environment and the system; "" = force direct. */
	manual?: string;
}

/**
 * Owns the proxy the main process's requests go through.
 *
 * Kept apart from the resolution logic so that stays pure: this part is the
 * file, the Electron session, and the one global side effect.
 */
export class ProxyService {
	private readonly filePath: string;
	private settings: StoredSettings | null = null;
	private status: ProxyStatus = { manual: null, source: "none" };

	constructor(
		private readonly options: {
			userDataDir: string;
			/** Chromium's proxy resolution; absent before a session exists. */
			resolveSystemProxy?: (url: string) => Promise<string>;
		},
	) {
		this.filePath = join(options.userDataDir, "proxy.json");
	}

	private load(): StoredSettings {
		if (this.settings) return this.settings;
		if (!existsSync(this.filePath)) {
			this.settings = {};
			return this.settings;
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
			const manual = (parsed as { manual?: unknown } | null)?.manual;
			this.settings = typeof manual === "string" ? { manual } : {};
		} catch {
			// A damaged file costs the override, not the app.
			this.settings = {};
		}
		return this.settings;
	}

	private persist(next: StoredSettings): void {
		mkdirSync(this.options.userDataDir, { recursive: true });
		const tmp = `${this.filePath}.tmp-${process.pid}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// best-effort cleanup of our own temp file
			}
			throw error;
		}
		this.settings = next;
	}

	/** Resolve and install the proxy. Safe to call again whenever it may differ. */
	async refresh(): Promise<ProxyStatus> {
		const stored = this.load();
		const resolution = await resolveProxy({
			...(stored.manual !== undefined ? { manual: stored.manual } : {}),
			env: process.env,
			targetUrl: PROBE_URL,
			...(this.options.resolveSystemProxy ? { resolveSystemProxy: this.options.resolveSystemProxy } : {}),
		});
		applyProxy(resolution.url);
		this.status = {
			manual: stored.manual ?? null,
			source: resolution.source,
			...(resolution.url ? { url: resolution.url } : {}),
			...(resolution.warning ? { warning: resolution.warning } : {}),
		};
		return this.status;
	}

	current(): ProxyStatus {
		return this.status;
	}

	/** `null` hands the choice back to the environment and the system. */
	async save(manual: string | null): Promise<ProxyStatus> {
		this.persist(manual === null ? {} : { manual: manual.trim() });
		return this.refresh();
	}
}
