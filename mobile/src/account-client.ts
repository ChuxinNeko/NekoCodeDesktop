import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import type { RelayDeviceSummary } from "../../src/shared/relay";

/**
 * Where the public backend lives.
 *
 * Hardcoded rather than read from an environment variable: the APK is built by
 * GitHub Actions, so a build-time variable would mean CI configuration for a
 * value that never changes, and a release built without it would ship pointing
 * at nothing. There is one public backend and this is its address.
 *
 * Only the reverse proxy and this line know the domain — the server itself does
 * not, because nothing it sends contains a link back to itself.
 */
export const ACCOUNT_API_BASE = "https://codeapi.nekofun.top";

/** Matches the server's error codes so the UI can branch on them. */
export type AccountErrorCode =
	| "invalid_request"
	/** The address already has a verified account — send the user to sign-in. */
	| "email_taken"
	| "invalid_credentials"
	| "email_unverified"
	| "invalid_code"
	| "code_expired"
	| "too_many_requests"
	| "unauthorized"
	| "account_locked"
	| "server_error"
	| "network";

export class AccountError extends Error {
	constructor(
		message: string,
		readonly code: AccountErrorCode,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface Account {
	id: string;
	email: string;
	createdAt: string;
}

interface StoredSession {
	accessToken: string;
	refreshToken: string;
	/** ms epoch the access token stops being accepted. */
	expiresAt: number;
	email: string;
}

interface TokenResponse {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	user: { id: string; email: string };
}

const STORAGE_KEY = "nekocode-account";
/** Refreshed this long before expiry, so a request never races the clock. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * The NekoCode account, as the phone sees it.
 *
 * Holds the token pair, refreshes it before it lapses, and hands every call an
 * Authorization header. The refresh token rotates on the server, which makes
 * concurrent refreshes the one thing that has to be got right: two requests
 * both noticing an expired token and both redeeming the same refresh token
 * would have one of them rejected and sign the user out for no reason. So
 * refreshes are funnelled through a single in-flight promise.
 */
export class AccountClient {
	private session: StoredSession | null = null;
	private refreshing: Promise<StoredSession | null> | null = null;

	get email(): string | null {
		return this.session?.email ?? null;
	}

	get signedIn(): boolean {
		return this.session !== null;
	}

	/** Load a session saved by a previous launch. */
	async restore(): Promise<boolean> {
		try {
			const raw = (await Preferences.get({ key: STORAGE_KEY })).value;
			const saved = raw ? (JSON.parse(raw) as Partial<StoredSession>) : null;
			if (
				saved &&
				typeof saved.accessToken === "string" &&
				typeof saved.refreshToken === "string" &&
				typeof saved.email === "string" &&
				typeof saved.expiresAt === "number"
			) {
				this.session = saved as StoredSession;
			}
		} catch {
			// A corrupt record is a signed-out app, not a crash.
			this.session = null;
		}
		return this.signedIn;
	}

	private async persist(session: StoredSession | null): Promise<void> {
		this.session = session;
		if (session) await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(session) });
		else await Preferences.remove({ key: STORAGE_KEY });
	}

	private store(tokens: TokenResponse): Promise<void> {
		return this.persist({
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: Date.now() + tokens.expiresIn * 1000,
			email: tokens.user.email,
		});
	}

	/**
	 * One request against the public backend.
	 *
	 * `CapacitorHttp` on a device, for the same reason the LAN client uses it:
	 * the WebView's own fetch is subject to CORS, and the native transport is
	 * not. In the browser during development the Vite proxy stands in.
	 */
	private async call<T>(
		path: string,
		method: "GET" | "POST" | "DELETE",
		body?: unknown,
		accessToken?: string,
	): Promise<T> {
		const headers: Record<string, string> = {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
		};
		let status: number;
		let payload: unknown;
		try {
			if (Capacitor.isNativePlatform()) {
				const response = await CapacitorHttp.request({
					url: ACCOUNT_API_BASE + path,
					method,
					headers,
					data: body,
					connectTimeout: 10_000,
					readTimeout: 20_000,
					responseType: "json",
				});
				status = response.status;
				payload = response.data;
			} else {
				const response = await fetch(`/account${path}`, {
					method,
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(20_000),
				});
				status = response.status;
				payload = status === 204 ? null : await response.json().catch(() => null);
			}
		} catch (cause) {
			throw new AccountError(
				cause instanceof Error && cause.name === "TimeoutError" ? "连接超时，请检查网络" : "无法连接服务器",
				"network",
			);
		}
		if (status < 200 || status >= 300) {
			const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
			throw new AccountError(
				error?.message ?? "请求失败",
				(error?.code as AccountErrorCode) ?? "server_error",
				status,
			);
		}
		return payload as T;
	}

	/**
	 * An access token that is good right now.
	 *
	 * Null means the session is gone and the caller has to sign in again.
	 */
	private async accessToken(): Promise<string | null> {
		const session = this.session;
		if (!session) return null;
		if (session.expiresAt - REFRESH_MARGIN_MS > Date.now()) return session.accessToken;
		const refreshed = await this.refresh();
		return refreshed?.accessToken ?? null;
	}

	/** Shared by every caller that notices an expired token at the same moment. */
	private refresh(): Promise<StoredSession | null> {
		this.refreshing ??= (async () => {
			const token = this.session?.refreshToken;
			if (!token) return null;
			try {
				const tokens = await this.call<TokenResponse>("/auth/refresh", "POST", { refreshToken: token });
				await this.store(tokens);
				return this.session;
			} catch (error) {
				// A refused refresh is a dead session; a flaky network is not, and
				// signing the user out over one would be wrong.
				if (error instanceof AccountError && error.code !== "network") await this.persist(null);
				return null;
			} finally {
				this.refreshing = null;
			}
		})();
		return this.refreshing;
	}

	/** An authenticated call, refreshing once if the token turns out to be stale. */
	private async authed<T>(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
		const token = await this.accessToken();
		if (!token) throw new AccountError("请先登录", "unauthorized", 401);
		try {
			return await this.call<T>(path, method, body, token);
		} catch (error) {
			if (!(error instanceof AccountError) || error.status !== 401) throw error;
			const refreshed = await this.refresh();
			if (!refreshed) throw new AccountError("登录状态已失效，请重新登录", "unauthorized", 401);
			return this.call<T>(path, method, body, refreshed.accessToken);
		}
	}

	/**
	 * Claim an address.
	 *
	 * Throws `email_taken` when the address already has a verified account, so
	 * the form can say so instead of sending the user to wait for a code that
	 * will never arrive.
	 */
	async register(email: string, password: string): Promise<void> {
		await this.call<{ ok: true }>("/auth/register", "POST", { email: email.trim(), password });
	}

	/** Redeem the six-digit code. Signs in on success. */
	async verify(email: string, code: string): Promise<Account> {
		const tokens = await this.call<TokenResponse>("/auth/verify", "POST", {
			email: email.trim(),
			code: code.trim(),
		});
		await this.store(tokens);
		return { ...tokens.user, createdAt: new Date().toISOString() };
	}

	async resend(email: string): Promise<void> {
		await this.call<{ ok: true }>("/auth/resend", "POST", { email: email.trim() });
	}

	async forgot(email: string): Promise<void> {
		await this.call<{ ok: true }>("/auth/forgot", "POST", { email: email.trim() });
	}

	async reset(email: string, code: string, newPassword: string): Promise<void> {
		await this.call<{ ok: true }>("/auth/reset", "POST", {
			email: email.trim(),
			code: code.trim(),
			newPassword,
		});
	}

	/**
	 * Sign in.
	 *
	 * Throws `email_unverified` when the password was right but the address was
	 * never confirmed — the server has just sent a fresh code, so the caller
	 * should show the verification screen rather than an error.
	 */
	async login(email: string, password: string): Promise<Account> {
		const tokens = await this.call<TokenResponse>("/auth/login", "POST", {
			email: email.trim(),
			password,
		});
		await this.store(tokens);
		return { ...tokens.user, createdAt: new Date().toISOString() };
	}

	me(): Promise<Account> {
		return this.authed<Account>("/auth/me", "GET");
	}

	/**
	 * A fresh access token for the relay WebSocket, which authenticates itself
	 * instead of going through `authed`. The refresh token never leaves here.
	 */
	async relayAccess(forceRefresh = false): Promise<{ accessToken: string; expiresAt: number }> {
		const current = this.session;
		if (forceRefresh && current) await this.persist({ ...current, expiresAt: 0 });
		const accessToken = await this.accessToken();
		const session = this.session;
		if (!accessToken || !session) throw new AccountError("请先登录", "unauthorized", 401);
		return { accessToken, expiresAt: session.expiresAt };
	}

	async relayDevices(): Promise<RelayDeviceSummary[]> {
		const payload = await this.authed<{ devices?: unknown }>("/relay/devices", "GET");
		const devices = payload?.devices;
		const valid =
			Array.isArray(devices) &&
			devices.length <= 20 &&
			devices.every(
				(device) =>
					device &&
					typeof device === "object" &&
					/^[a-f0-9]{64}$/.test((device as RelayDeviceSummary).id) &&
					typeof (device as RelayDeviceSummary).name === "string" &&
					(device as RelayDeviceSummary).name.length >= 1 &&
					(device as RelayDeviceSummary).name.length <= 60 &&
					typeof (device as RelayDeviceSummary).publicKey === "string" &&
					typeof (device as RelayDeviceSummary).lastSeenAt === "string" &&
					!Number.isNaN(Date.parse((device as RelayDeviceSummary).lastSeenAt)) &&
					typeof (device as RelayDeviceSummary).online === "boolean",
			);
		if (!valid) throw new AccountError("服务器返回了无法识别的设备列表", "server_error");
		return devices as RelayDeviceSummary[];
	}

	async removeRelayDevice(id: string): Promise<void> {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new AccountError("设备编号不正确", "invalid_request", 400);
		await this.authed(`/relay/devices/${encodeURIComponent(id)}`, "DELETE");
	}

	async logout(): Promise<void> {
		const token = this.session?.refreshToken;
		// Cleared locally whatever the server says: a failed call must not leave
		// the user looking signed in on a device they meant to sign out of.
		await this.persist(null);
		if (token) await this.call("/auth/logout", "POST", { refreshToken: token }).catch(() => undefined);
	}

	/** Sign out every device — what a lost phone needs. */
	async logoutEverywhere(): Promise<void> {
		await this.authed("/auth/logout-all", "POST").catch(() => undefined);
		await this.persist(null);
	}
}

export const account = new AccountClient();
