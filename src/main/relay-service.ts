import { hostname } from "node:os";
import type { safeStorage } from "electron";
import type {
	RelayIdentity,
	RelayLoginRequest,
	RelayRegisterRequest,
	RelayRequest,
	RelayResendRequest,
	RelayResponse,
	RelayStatus,
	RelayVerifyRequest,
} from "../shared/relay";
import {
	decryptRelayJson,
	deriveRelayKey,
	encryptRelayJson,
	isRelayCiphertext,
	isRelayPublicKey,
	relayAad,
	relayPublicId,
} from "../shared/relay-crypto";
import type { LanService } from "./lan-service";
import { RelayCredentialStore, type RelayAccountSession } from "./relay-credential-store";

const ACCOUNT_API_BASE = "https://codeapi.nekofun.top";
const RELAY_WS_URL = "wss://codeapi.nekofun.top/relay/desktop";
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const TOKEN_MARGIN_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[a-f0-9]{64}$/;

interface RelaySocket {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: (() => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
}

class RelayHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

interface Peer {
	peerId: string;
	key: Promise<CryptoKey | null>;
}

export interface RelayServiceDeps {
	userDataDir: string;
	encryption: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend">;
	gateway: Pick<LanService, "handleRelay">;
	emit: (status: RelayStatus) => void;
	fetch?: typeof globalThis.fetch;
	webSocketFactory?: (url: string) => WebSocket;
	deviceName?: () => string;
}

export class RelayService {
	private readonly store: RelayCredentialStore;
	private identity: RelayIdentity | null = null;
	private session: RelayAccountSession | null = null;
	private state: RelayStatus["state"] = "signed-out";
	private lastError: string | undefined;
	private socket: RelaySocket | null = null;
	private readonly peers = new Map<string, Peer>();
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private attempt = 0;
	private started = false;
	private starting: Promise<RelayStatus> | null = null;
	private closed = false;
	private refreshing: Promise<string> | null = null;

	constructor(private readonly deps: RelayServiceDeps) {
		this.store = new RelayCredentialStore(deps.userDataDir, deps.encryption);
	}

	status(): RelayStatus {
		return {
			state: this.state,
			account: this.session ? { email: this.session.user.email } : null,
			device: this.identity ? { id: this.identity.id, name: this.deviceName() } : null,
			...(this.state === "error" && this.lastError ? { error: this.lastError } : {}),
		};
	}

	async start(): Promise<RelayStatus> {
		if (this.starting) return this.starting;
		if (this.closed || this.started) return this.status();
		this.started = true;
		this.starting = (async () => {
			try {
				this.identity = await this.store.identity();
				this.session = this.store.account();
			} catch (error) {
				this.setState("error", error instanceof Error ? error.message : String(error));
				return this.status();
			}
			if (this.session) this.dial();
			else this.setState("signed-out");
			return this.status();
		})().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async prepareAuth(): Promise<void> {
		if (this.closed) throw new Error("公网连接服务已关闭");
		await this.start();
		if (this.session) throw new Error("当前已登录账号，请先退出");
		this.identity = await this.store.identity();
	}

	private async acceptTokens(tokens: unknown): Promise<RelayStatus> {
		const session = parseSessionResponse(tokens);
		if (!session) throw new Error("服务器返回了无法识别的登录响应");
		this.session = session;
		this.store.writeAccount(session);
		this.dial();
		return this.status();
	}

	async login(request: RelayLoginRequest): Promise<RelayStatus> {
		await this.prepareAuth();
		const email = request.email.trim();
		const tokens = await this.api<unknown>("/auth/login", { method: "POST", body: { email, password: request.password } });
		return this.acceptTokens(tokens);
	}

	async register(request: RelayRegisterRequest): Promise<void> {
		await this.prepareAuth();
		await this.api("/auth/register", {
			method: "POST",
			body: { email: request.email.trim(), password: request.password },
		});
	}

	async verify(request: RelayVerifyRequest): Promise<RelayStatus> {
		await this.prepareAuth();
		const tokens = await this.api<unknown>("/auth/verify", {
			method: "POST",
			body: { email: request.email.trim(), code: request.code.trim() },
		});
		return this.acceptTokens(tokens);
	}

	async resend(request: RelayResendRequest): Promise<void> {
		if (this.closed) throw new Error("公网连接服务已关闭");
		await this.start();
		if (this.session) throw new Error("当前已登录账号，请先退出");
		await this.api("/auth/resend", { method: "POST", body: { email: request.email.trim() } });
	}

	async logout(): Promise<RelayStatus> {
		const session = this.session;
		if (!session) {
			this.setState("signed-out");
			return this.status();
		}
		this.stopConnection();
		try {
			const token = await this.access();
			await this.api(`/relay/devices/${this.identity?.id ?? ""}`, { method: "DELETE", token });
		} catch (error) {
			if (this.session) this.dial();
			throw error;
		}
		if (this.session) {
			await this.api("/auth/logout", { method: "POST", body: { refreshToken: this.session.refreshToken } }).catch(() => undefined);
		}
		this.session = null;
		this.store.clearAccount();
		this.setState("signed-out");
		return this.status();
	}

	async reconnect(): Promise<RelayStatus> {
		if (this.closed) return this.status();
		this.stopConnection();
		if (this.session) this.dial();
		else this.setState("signed-out");
		return this.status();
	}

	close(): void {
		this.closed = true;
		this.stopConnection();
	}

	private setState(state: RelayStatus["state"], error?: string): void {
		this.state = state;
		this.lastError = error;
		this.deps.emit(this.status());
	}

	private deviceName(): string {
		const raw = this.deps.deviceName?.() ?? hostname();
		return raw.trim().slice(0, 60) || "NekoCode Desktop";
	}

	private async api<T>(path: string, init: { method: string; body?: unknown; token?: string }): Promise<T> {
		const fetchImpl = this.deps.fetch ?? globalThis.fetch;
		const response = await fetchImpl(`${ACCOUNT_API_BASE}${path}`, {
			method: init.method,
			headers: {
				...(init.body !== undefined ? { "content-type": "application/json" } : {}),
				...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
		});
		const payload: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
			throw new RelayHttpError(typeof message === "string" && message ? message : "请求失败", response.status);
		}
		return payload as T;
	}

	private access(): Promise<string> {
		const session = this.session;
		if (!session) return Promise.reject(new RelayHttpError("请先登录", 401));
		if (session.expiresAt - TOKEN_MARGIN_MS > Date.now()) return Promise.resolve(session.accessToken);
		this.refreshing ??= (async () => {
			const current = this.session;
			if (!current) throw new RelayHttpError("请先登录", 401);
			try {
				const tokens = await this.api<unknown>("/auth/refresh", { method: "POST", body: { refreshToken: current.refreshToken } });
				const next = parseSessionResponse(tokens);
				if (!next || next.user.id !== current.user.id || next.user.email !== current.user.email) {
					throw new RelayHttpError("登录状态已失效，请重新登录", 401);
				}
				this.session = next;
				this.store.writeAccount(next);
				return next.accessToken;
			} catch (error) {
				if (error instanceof RelayHttpError) {
					this.session = null;
					this.store.clearAccount();
					this.stopConnection();
					this.setState("signed-out");
					throw new RelayHttpError("登录状态已失效，请重新登录", error.status);
				}
				throw error;
			} finally {
				this.refreshing = null;
			}
		})();
		return this.refreshing;
	}

	private dial(): void {
		if (this.closed || !this.session || !this.identity) return;
		this.clearReconnect();
		this.setState("connecting");
		const factory = this.deps.webSocketFactory ?? ((url: string) => new WebSocket(url));
		let ws: RelaySocket;
		try {
			ws = factory(RELAY_WS_URL) as unknown as RelaySocket;
		} catch {
			this.schedule("公网连接已断开");
			return;
		}
		this.socket = ws;
		ws.onopen = () => {
			void (async () => {
				try {
					const token = await this.access();
					if (this.socket !== ws || !this.session || !this.identity) return;
					ws.send(JSON.stringify({
						type: "hello",
						protocol: 1,
						accessToken: token,
						device: { id: this.identity.id, name: this.deviceName(), publicKey: this.identity.publicKey },
					}));
				} catch {
					this.drop(ws);
					this.schedule("公网连接已断开");
				}
			})();
		};
		ws.onmessage = (event) => {
			void this.onMessage(ws, event.data).catch(() => undefined);
		};
		ws.onerror = () => {};
		ws.onclose = (event) => {
			if (this.socket !== ws) return;
			this.socket = null;
			this.clearPing();
			this.peers.clear();
			if (this.closed || !this.session) return;
			if (event.code === 4403) {
				this.setState("error", "设备已绑定其他账号，请先用原账号注销");
				return;
			}
			if (event.code === 4401 && this.session) {
				this.session = { ...this.session, expiresAt: 0 };
				this.store.writeAccount(this.session);
			}
			this.schedule(event.reason || this.lastError || "公网连接已断开");
		};
	}

	private schedule(reason: string): void {
		if (this.closed || !this.session) return;
		this.clearReconnect();
		const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
		this.attempt += 1;
		this.setState("error", reason);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.dial();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	private drop(ws: RelaySocket): void {
		if (this.socket === ws) this.socket = null;
		this.clearPing();
		this.peers.clear();
		try {
			ws.close(1000);
		} catch {}
	}

	private stopConnection(): void {
		this.clearReconnect();
		this.clearPing();
		this.peers.clear();
		const ws = this.socket;
		this.socket = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {}
		}
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private clearPing(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = null;
	}

	private async onMessage(ws: RelaySocket, data: unknown): Promise<void> {
		if (this.socket !== ws) return;
		if (typeof data !== "string") return this.protocolError(ws);
		let message: unknown;
		try {
			message = JSON.parse(data);
		} catch {
			return this.protocolError(ws);
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) return this.protocolError(ws);
		const type = (message as { type?: unknown }).type;
		if (type === "ready") {
			this.attempt = 0;
			this.lastError = undefined;
			this.setState("ready");
			this.clearPing();
			this.pingTimer = setInterval(() => {
				try {
					if (this.socket === ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
				} catch {}
			}, PING_INTERVAL_MS);
			this.pingTimer.unref?.();
			return;
		}
		if (type === "pong") return;
		if (type === "peer") {
			const peer = (message as { peer?: unknown }).peer;
			const connectionId = (message as { connectionId?: unknown }).connectionId;
			const peerId = (peer as { id?: unknown } | null)?.id;
			const publicKey = (peer as { publicKey?: unknown } | null)?.publicKey;
			if (
				typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId) ||
				typeof peerId !== "string" || !ID_PATTERN.test(peerId) ||
				!isRelayPublicKey(publicKey)
			) return this.protocolError(ws);
			const identity = this.identity;
			if (!identity) return;
			const entry: Peer = {
				peerId,
				key: (async () => {
					try {
						if ((await relayPublicId(publicKey)) !== peerId) return null;
						return await deriveRelayKey(identity, publicKey);
					} catch {
						return null;
					}
				})(),
			};
			entry.key = entry.key.then((key) => {
				if (key === null && this.peers.get(connectionId) === entry) this.peers.delete(connectionId);
				return key;
			});
			this.peers.set(connectionId, entry);
			return;
		}
		if (type === "peer-closed") {
			const connectionId = (message as { connectionId?: unknown }).connectionId;
			if (typeof connectionId === "string") this.peers.delete(connectionId);
			return;
		}
		if (type === "frame") {
			const connectionId = (message as { connectionId?: unknown }).connectionId;
			const payload = (message as { payload?: unknown }).payload;
			if (typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId) || !isRelayCiphertext(payload)) return;
			const peer = this.peers.get(connectionId);
			const identity = this.identity;
			if (!peer || !identity) return;
			void (async () => {
				const key = await peer.key.catch(() => null);
				if (!key) return;
				let request: RelayRequest;
				try {
					request = await decryptRelayJson<RelayRequest>(
						key,
						payload,
						relayAad(connectionId, identity.id, peer.peerId, "mobile-to-desktop"),
					);
				} catch {
					// A frame we cannot open carries no request id to answer with.
					return;
				}
				const reply = async (response: RelayResponse): Promise<void> => {
					const sealed = await encryptRelayJson(
						key,
						response,
						relayAad(connectionId, identity.id, peer.peerId, "desktop-to-mobile"),
					);
					if (this.socket === ws && ws.readyState === 1) {
						ws.send(JSON.stringify({ type: "frame", connectionId, payload: sealed }));
					}
				};
				try {
					await reply(await this.deps.gateway.handleRelay(peer.peerId, request));
				} catch (error) {
					// Usually the response outgrew the relay's frame limit. Answering
					// beats dropping it: the phone would otherwise sit on the request
					// until its timeout with nothing to show for the wait.
					const id = typeof request.id === "string" ? request.id : "";
					const message = error instanceof Error ? error.message : "响应无法通过中继发送";
					await reply({ id, status: 502, body: { error: message } }).catch(() => undefined);
				}
			})();
			return;
		}
		if (type === "error") {
			const text = (message as { message?: unknown }).message;
			if (typeof text === "string") this.lastError = text;
			return;
		}
		return this.protocolError(ws);
	}

	private protocolError(ws: RelaySocket): void {
		try {
			ws.close(4400, "中继协议错误");
		} catch {}
	}
}

function parseSessionResponse(value: unknown): RelayAccountSession | null {
	if (!value || typeof value !== "object") return null;
	const tokens = value as { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown; user?: { id?: unknown; email?: unknown } };
	if (
		typeof tokens.accessToken !== "string" || !tokens.accessToken || tokens.accessToken.length > 4096 ||
		typeof tokens.refreshToken !== "string" || !tokens.refreshToken || tokens.refreshToken.length > 4096 ||
		typeof tokens.expiresIn !== "number" || !Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0 ||
		typeof tokens.user?.id !== "string" || !tokens.user.id ||
		typeof tokens.user?.email !== "string" || !tokens.user.email
	) return null;
	return {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: Date.now() + tokens.expiresIn * 1000,
		user: { id: tokens.user.id, email: tokens.user.email },
	};
}
