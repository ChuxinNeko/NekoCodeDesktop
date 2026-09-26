/**
 * Signing in to an agent that speaks ACP itself.
 *
 * Agents advertise their sign-in methods in `initialize`, and some — Cursor,
 * Grok, Droid — want `authenticate` called before they will open a session.
 * Every method chosen here reuses a login the user already made in the agent's
 * own CLI, or an API key from the environment: NekoCode never starts a browser
 * login in the middle of opening a conversation, it says what to run instead.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AcpAuthChoice {
	methodId: string;
	meta?: Record<string, unknown>;
}

export interface AcpAuthPlan {
	/**
	 * `always`: right after `initialize`, before any session is opened.
	 * `on-demand`: only once opening a session came back "auth required".
	 */
	when: "always" | "on-demand";
	/**
	 * The method to use, given the advertised method ids and the environment
	 * the agent runs with. Null skips `authenticate`; a thrown error says what
	 * the user has to do first.
	 */
	choose: (advertised: readonly string[], env: Record<string, string | undefined>) => Promise<AcpAuthChoice | null>;
}

/** Signing in failed for a reason the user has to fix; the message says how. */
export class AcpAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpAuthError";
	}
}

function envValue(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
		const value = key ? env[key]?.trim() : undefined;
		if (value) return value;
	}
	return undefined;
}

function listed(advertised: readonly string[]): string {
	return advertised.length > 0 ? advertised.join("、") : "无";
}

/** Cursor takes its own stored login; `headless` keeps it from opening a browser. */
export const CURSOR_AUTH: AcpAuthPlan = {
	when: "always",
	choose: async () => ({ methodId: "cursor_login", meta: { headless: true } }),
};

export const GROK_API_KEY_ENV = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] as const;
const GROK_INTERACTIVE = new Set(["browser_login", "grok.com"]);

export const GROK_AUTH: AcpAuthPlan = {
	when: "always",
	choose: async (advertised, env) => {
		const hasKey = !!envValue(env, GROK_API_KEY_ENV);
		if (hasKey && advertised.includes("xai.api_key")) return { methodId: "xai.api_key" };
		if (advertised.includes("cached_token")) return { methodId: "cached_token" };
		if (advertised.length === 0) return null;
		if (!hasKey && advertised.includes("xai.api_key")) {
			throw new AcpAuthError("Grok 需要登录：请先在终端运行 grok login，或为 Grok 设置环境变量 XAI_API_KEY。");
		}
		if (advertised.every((id) => GROK_INTERACTIVE.has(id))) {
			throw new AcpAuthError(`Grok 尚未登录（它只提供浏览器登录：${listed(advertised)}）。请先在终端运行 grok login，然后重新创建会话。`);
		}
		throw new AcpAuthError(`Grok 没有提供可用的无界面登录方式（支持：${listed(advertised)}）。请更新 Grok CLI 后重试。`);
	},
};

export const DROID_API_KEY_ENV = ["FACTORY_API_KEY"] as const;

export const DROID_AUTH: AcpAuthPlan = {
	when: "always",
	choose: async (advertised, env) => {
		if (envValue(env, DROID_API_KEY_ENV) && advertised.includes("factory-api-key")) return { methodId: "factory-api-key" };
		// Succeeds straight away with the login `droid` stored; pairs a device only without one.
		if (advertised.includes("device-pairing")) return { methodId: "device-pairing" };
		if (advertised.length === 0) return null;
		throw new AcpAuthError(`Droid 需要登录（支持：${listed(advertised)}）。请先在终端运行 droid 完成登录，或设置环境变量 FACTORY_API_KEY。`);
	},
};

export const DEVIN_API_KEY_ENV = ["WINDSURF_API_KEY", "DEVIN_API_KEY"] as const;
const DEVIN_API_SERVER_ENV = ["WINDSURF_API_SERVER_URL", "DEVIN_API_SERVER_URL"] as const;
const DEVIN_API_KEY_METHODS = ["windsurf-api-key", "windsurf.api_key", "devin.api_key", "api_key"];
const DEVIN_INTERACTIVE = new Set(["browser_login", "devin-browser", "devin.com", "oauth"]);

export interface DevinCredentials {
	apiKey?: string;
	apiServerUrl?: string;
}

function tomlString(raw: string): string | undefined {
	const value = raw.trim();
	if (value.startsWith('"')) {
		const end = value.lastIndexOf('"');
		if (end <= 0) return undefined;
		try {
			const parsed: unknown = JSON.parse(value.slice(0, end + 1));
			return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("'")) {
		const end = value.lastIndexOf("'");
		return end > 0 ? value.slice(1, end).trim() || undefined : undefined;
	}
	return value.split("#", 1)[0]?.trim() || undefined;
}

/** The two fields `devin auth login` writes that matter here; nothing else is read. */
export function parseDevinCredentials(raw: string): DevinCredentials | undefined {
	const credentials: DevinCredentials = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = line.trimStart().match(/^(windsurf_api_key|api_server_url)\s*=\s*(.+)$/);
		const value = match ? tomlString(match[2]) : undefined;
		if (!match || !value) continue;
		if (match[1] === "windsurf_api_key") credentials.apiKey = value;
		else credentials.apiServerUrl = value;
	}
	return credentials.apiKey || credentials.apiServerUrl ? credentials : undefined;
}

export function devinCredentialsPath(env: Record<string, string | undefined>, platform: NodeJS.Platform): string | undefined {
	if (platform === "win32") {
		const appData = envValue(env, ["APPDATA"]);
		if (appData) return join(appData, "devin", "credentials.toml");
	}
	const home = envValue(env, ["HOME", "USERPROFILE"]);
	if (!home) return undefined;
	return join(envValue(env, ["XDG_DATA_HOME"]) ?? join(home, ".local", "share"), "devin", "credentials.toml");
}

/** Only HTTPS, or plain HTTP to this machine: an API key is attached to it. */
function safeServerUrl(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (url.username || url.password) return undefined;
		if (url.protocol === "https:") return raw;
		if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return raw;
	} catch {
		// Malformed: leave it out rather than send a key somewhere unknown.
	}
	return undefined;
}

export function devinAuthPlan(
	readCredentials: (env: Record<string, string | undefined>) => Promise<DevinCredentials | undefined> = async (env) => {
		const path = devinCredentialsPath(env, process.platform);
		const raw = path ? await readFile(path, "utf8").catch(() => undefined) : undefined;
		return raw === undefined ? undefined : parseDevinCredentials(raw);
	},
): AcpAuthPlan {
	return {
		when: "on-demand",
		choose: async (advertised, env) => {
			const stored = await readCredentials(env).catch(() => undefined);
			const apiKey = envValue(env, DEVIN_API_KEY_ENV) ?? stored?.apiKey;
			const serverUrl = safeServerUrl(envValue(env, DEVIN_API_SERVER_ENV) ?? stored?.apiServerUrl);
			const meta = { headless: true, ...(apiKey ? { api_key: apiKey } : {}), ...(serverUrl ? { api_server_url: serverUrl } : {}) };
			if (apiKey) {
				const method = advertised.find((id) => DEVIN_API_KEY_METHODS.includes(id));
				if (method) return { methodId: method, meta };
				// Some Devin builds advertise only the browser login, yet accept the key method.
				if (advertised.includes("devin-browser")) return { methodId: "windsurf-api-key", meta };
			}
			if (advertised.includes("cached_token")) return { methodId: "cached_token", meta };
			const headless = advertised.find((id) => !DEVIN_INTERACTIVE.has(id));
			if (headless) return { methodId: headless, meta };
			throw new AcpAuthError(
				`Devin 尚未登录（支持：${listed(advertised)}）。请先在终端运行 devin auth login，或设置环境变量 WINDSURF_API_KEY，然后重新创建会话。`,
			);
		},
	};
}

export const DEVIN_AUTH: AcpAuthPlan = devinAuthPlan();

/** The ids of the sign-in methods an `initialize` result advertises. */
export function advertisedAuthMethods(init: unknown): string[] {
	if (!init || typeof init !== "object" || Array.isArray(init)) return [];
	const methods = (init as Record<string, unknown>).authMethods;
	if (!Array.isArray(methods)) return [];
	return methods
		.map((method) => (method && typeof method === "object" ? (method as Record<string, unknown>).id : undefined))
		.filter((id): id is string => typeof id === "string" && !!id.trim())
		.map((id) => id.trim());
}

/**
 * Run `authenticate` as the plan says. Returns whether it ran: a plan may find
 * nothing to do when the agent advertises no methods at all.
 */
export async function authenticateAgent(
	request: (method: string, params: unknown) => Promise<unknown>,
	plan: AcpAuthPlan,
	init: unknown,
	env: Record<string, string | undefined>,
	agentName: string,
): Promise<boolean> {
	const choice = await plan.choose(advertisedAuthMethods(init), env);
	if (!choice) return false;
	try {
		await request("authenticate", { methodId: choice.methodId, ...(choice.meta ? { _meta: choice.meta } : {}) });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AcpAuthError(`${agentName} 登录失败（${choice.methodId}）：${reason}。请先在终端里完成该代理自己的登录，然后重新创建会话。`);
	}
	return true;
}
