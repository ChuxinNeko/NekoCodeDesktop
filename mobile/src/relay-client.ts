import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import type { AgentDefaults, AgentSnapshot, SendPromptResult } from "../../src/shared/agent";
import type { AgentSnapshotDelta } from "../../src/shared/agent-delta";
import type { DeltaRequest, ToolOutputChunk } from "./desktop-client";
import type { LanState, LanTaskOptions } from "../../src/shared/lan";
import type { WorkflowAnswer } from "../../src/shared/workflow";
import type { SlashCommandSummary } from "../../src/shared/commands";
import type { RelayDeviceSummary, RelayIdentity, RelayRequest, RelayResponse } from "../../src/shared/relay";
import {
	deriveRelayKey,
	decryptRelayJson,
	encryptRelayJson,
	isRelayCiphertext,
	isRelayPublicKey,
	relayAad,
	relayPublicId,
} from "../../src/shared/relay-crypto";
import { account } from "./account-client";
import { LanError, type SubmitResult } from "./lan-client";
import { MobileRelayIdentityStore, type PreferencesLike } from "./relay-identity";

export interface RelayBinding {
	accountEmail: string;
	desktop: { id: string; name: string; publicKey: string };
}

export interface RelayAccountLike {
	readonly email: string | null;
	relayAccess(forceRefresh?: boolean): Promise<{ accessToken: string; expiresAt: number }>;
	relayDevices(): Promise<RelayDeviceSummary[]>;
}

export interface RelayClientDeps {
	account?: RelayAccountLike;
	preferences?: PreferencesLike;
	webSocketFactory?: (url: string) => WebSocket;
	endpoint?: string;
}

const BINDING_KEY = "relay-desktop-binding";
const PENDING_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const PING_INTERVAL_MS = 25_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE_ID_PATTERN = /^[a-f0-9]{64}$/;

interface PendingRequest {
	resolve: (body: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Connected {
	socket: WebSocket;
	connectionId: string;
	key: CryptoKey;
	ping: ReturnType<typeof setInterval>;
}

function defaultEndpoint(): string {
	if (Capacitor.isNativePlatform()) return "wss://codeapi.nekofun.top/relay/mobile";
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/relay/mobile`;
}

function isDesktopShape(value: unknown): value is RelayBinding["desktop"] {
	if (!value || typeof value !== "object") return false;
	const desktop = value as RelayBinding["desktop"];
	return (
		DEVICE_ID_PATTERN.test(desktop.id) &&
		typeof desktop.name === "string" &&
		desktop.name.length >= 1 &&
		desktop.name.length <= 60 &&
		isRelayPublicKey(desktop.publicKey)
	);
}

export class RelayClient {
	binding: RelayBinding | null = null;
	private readonly account: RelayAccountLike;
	private readonly preferences: PreferencesLike;
	private readonly webSocketFactory: (url: string) => WebSocket;
	private readonly endpoint?: string;
	private readonly identityStore: MobileRelayIdentityStore;
	private identity: RelayIdentity | null = null;
	private live: Connected | null = null;
	private connecting: Promise<Connected> | null = null;
	private connectionGeneration = 0;
	private pending = new Map<string, PendingRequest>();
	private serverError: { code: string; message: string } | null = null;
	private forceRefresh = false;

	constructor(deps: RelayClientDeps = {}) {
		this.account = deps.account ?? account;
		this.preferences = deps.preferences ?? Preferences;
		this.webSocketFactory = deps.webSocketFactory ?? ((url) => new WebSocket(url));
		this.endpoint = deps.endpoint;
		this.identityStore = new MobileRelayIdentityStore(this.preferences);
	}

	async restore(): Promise<RelayBinding | null> {
		try {
			const raw = (await this.preferences.get({ key: BINDING_KEY })).value;
			const saved = raw ? (JSON.parse(raw) as Partial<RelayBinding>) : null;
			const email = this.account.email;
			if (
				saved &&
				typeof saved.accountEmail === "string" &&
				email &&
				saved.accountEmail.toLowerCase() === email.toLowerCase() &&
				isDesktopShape(saved.desktop) &&
				(await relayPublicId(saved.desktop.publicKey)) === saved.desktop.id
			) {
				this.binding = { accountEmail: saved.accountEmail, desktop: { ...saved.desktop } };
			} else {
				this.binding = null;
			}
		} catch {
			this.binding = null;
		}
		return this.binding;
	}

	async listDevices(): Promise<RelayDeviceSummary[]> {
		const devices = await this.account.relayDevices();
		for (const device of devices) {
			if (!isRelayPublicKey(device.publicKey) || (await relayPublicId(device.publicKey)) !== device.id) {
				throw new LanError("设备公钥校验失败", 502);
			}
		}
		return devices;
	}

	async select(device: RelayDeviceSummary): Promise<void> {
		const email = this.account.email;
		if (!email) throw new LanError("请先登录", 401);
		if (!isRelayPublicKey(device.publicKey) || (await relayPublicId(device.publicKey)) !== device.id) {
			throw new LanError("设备公钥校验失败", 502);
		}
		this.binding = {
			accountEmail: email,
			desktop: { id: device.id, name: device.name.trim().slice(0, 60) || "NekoCode Desktop", publicKey: device.publicKey },
		};
		await this.preferences.set({ key: BINDING_KEY, value: JSON.stringify(this.binding) });
		this.failAll(new LanError("连接已切换"));
		this.closeSocket(1000, "");
	}

	async disconnect(): Promise<void> {
		this.failAll(new LanError("连接已断开"));
		this.closeSocket(1000, "");
	}

	async forget(): Promise<void> {
		this.binding = null;
		await this.disconnect();
		await this.preferences.remove({ key: BINDING_KEY });
	}

	private failAll(error: Error): void {
		const pendings = [...this.pending.values()];
		this.pending.clear();
		for (const pending of pendings) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}

	private closeSocket(code: number, reason: string): void {
		this.connectionGeneration++;
		this.connecting = null;
		const live = this.live;
		const socket = this.latestSocket;
		this.live = null;
		this.latestSocket = null;
		if (live) clearInterval(live.ping);
		if (socket) {
			try {
				socket.close(code, reason);
			} catch {
				// already gone
			}
		}
	}

	private closeError(code: number, reason: string | undefined): LanError {
		const saved = this.serverError;
		this.serverError = null;
		if (code === 4401 || saved?.code === "unauthorized") {
			this.forceRefresh = true;
			return new LanError(saved?.message ?? "登录状态已失效，请重新登录", 401);
		}
		if (code === 4404 || saved?.code === "desktop_offline") return new LanError(saved?.message ?? "桌面端不在线", 503);
		if (code === 4403 || saved?.code === "forbidden") return new LanError(saved?.message ?? "无权连接该设备", 403);
		return new LanError(reason || saved?.message || "连接中断");
	}

	private ensureConnected(): Promise<Connected> {
		if (this.live) return Promise.resolve(this.live);
		if (this.connecting) return this.connecting;
		const generation = this.connectionGeneration;
		const attempt = this.open(generation);
		this.connecting = attempt;
		void attempt.then(
			() => {
				if (this.connecting === attempt) this.connecting = null;
			},
			() => {
				if (this.connecting === attempt) this.connecting = null;
			},
		);
		return attempt;
	}

	private async open(generation: number): Promise<Connected> {
		const binding = this.binding;
		if (!binding) throw new LanError("请先选择电脑", 401);
		this.serverError = null;
		const { accessToken } = await this.account.relayAccess(this.forceRefresh);
		this.forceRefresh = false;
		if (generation !== this.connectionGeneration) throw new LanError("连接已取消");
		const identity = (this.identity ??= await this.identityStore.load());
		if (generation !== this.connectionGeneration) throw new LanError("连接已取消");
		return new Promise<Connected>((resolve, reject) => {
			if (generation !== this.connectionGeneration) {
				reject(new LanError("连接已取消"));
				return;
			}
			let settled = false;
			const socket = this.webSocketFactory(this.endpoint ?? defaultEndpoint());
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			socket.onopen = () => {
				socket.send(
					JSON.stringify({
						type: "hello",
						protocol: 1,
						accessToken,
						desktopId: binding.desktop.id,
						peer: { id: identity.id, publicKey: identity.publicKey },
					}),
				);
			};
			socket.onmessage = (event) => {
				if (this.latestSocket !== socket) return;
				void this.onMessage(socket, event.data, binding, identity, resolve, fail, () => {
					settled = true;
				});
			};
			socket.onclose = (event) => {
				if (this.latestSocket !== socket) {
					fail(new LanError("连接已断开"));
					return;
				}
				this.latestSocket = null;
				const error = this.closeError(event.code, event.reason);
				const live = this.live;
				if (live?.socket === socket) {
					this.live = null;
					clearInterval(live.ping);
				}
				fail(error);
				this.failAll(error);
			};
			socket.onerror = () => undefined;
			this.track(socket);
		});
	}

	private latestSocket: WebSocket | null = null;
	private track(socket: WebSocket): void {
		const previous = this.latestSocket;
		this.latestSocket = socket;
		if (previous && previous !== socket) {
			const live = this.live;
			if (live?.socket === previous) {
				this.live = null;
				clearInterval(live.ping);
			}
			try {
				previous.close(1000, "");
			} catch {
				// already gone
			}
		}
	}

	private async onMessage(
		socket: WebSocket,
		data: unknown,
		binding: RelayBinding,
		identity: RelayIdentity,
		resolve: (connected: Connected) => void,
		fail: (error: Error) => void,
		markSettled: () => void,
	): Promise<void> {
		if (typeof data !== "string") return;
		let message: { type?: unknown };
		try {
			message = JSON.parse(data) as { type?: unknown };
		} catch {
			socket.close(4400, "中继协议错误");
			return;
		}
		if (!message || typeof message !== "object") {
			socket.close(4400, "中继协议错误");
			return;
		}
		if (message.type === "pong") return;
		if (message.type === "error") {
			const error = message as { code?: unknown; message?: unknown };
			this.serverError = {
				code: typeof error.code === "string" ? error.code : "",
				message: typeof error.message === "string" ? error.message : "",
			};
			return;
		}
		if (message.type === "ready") {
			if (this.live?.socket === socket) return;
			const ready = message as { connectionId?: unknown; desktop?: unknown };
			const desktop = ready.desktop as RelayBinding["desktop"];
			if (
				typeof ready.connectionId !== "string" ||
				!UUID_PATTERN.test(ready.connectionId) ||
				!isDesktopShape(desktop) ||
				desktop.id !== binding.desktop.id ||
				desktop.publicKey !== binding.desktop.publicKey
			) {
				socket.close(4400, "中继协议错误");
				return;
			}
			try {
				const key = await deriveRelayKey(identity, desktop.publicKey);
				if (this.latestSocket !== socket) return;
				const ping = setInterval(() => {
					try {
						if (this.live?.socket === socket) socket.send(JSON.stringify({ type: "ping" }));
					} catch {
						// closed sockets throw on send; the close handler owns cleanup
					}
				}, PING_INTERVAL_MS);
				(ping as unknown as { unref?: () => void }).unref?.();
				const name = desktop.name.trim().slice(0, 60);
				if (name && name !== this.binding?.desktop.name) {
					this.binding = { accountEmail: binding.accountEmail, desktop: { ...binding.desktop, name } };
					void this.preferences.set({ key: BINDING_KEY, value: JSON.stringify(this.binding) });
				}
				this.live = { socket, connectionId: ready.connectionId, key, ping };
				markSettled();
				resolve(this.live);
			} catch {
				socket.close(4400, "中继协议错误");
			}
			return;
		}
		const live = this.live;
		if (!live || live.socket !== socket) {
			socket.close(4400, "中继协议错误");
			return;
		}
		if (message.type === "frame") {
			const payload = (message as { payload?: unknown }).payload;
			if (!isRelayCiphertext(payload)) return;
			try {
				const response = await decryptRelayJson<RelayResponse>(
					live.key,
					payload,
					relayAad(live.connectionId, binding.desktop.id, identity.id, "desktop-to-mobile"),
				);
				if (
					typeof response?.id !== "string" ||
					typeof response?.status !== "number" ||
					!Number.isInteger(response.status) ||
					response.status < 100 ||
					response.status > 599
				) {
					return;
				}
				const request = this.pending.get(response.id);
				if (!request) return;
				this.pending.delete(response.id);
				clearTimeout(request.timer);
				if (response.status >= 200 && response.status < 300) {
					request.resolve(response.body);
				} else {
					request.reject(new LanError((response.body as { error?: string } | null)?.error ?? "请求失败", response.status));
				}
			} catch {
				// A bad frame only loses itself.
			}
			return;
		}
		socket.close(4400, "中继协议错误");
	}

	private async request<T>(path: string, data?: unknown): Promise<T> {
		const binding = this.binding;
		if (!binding) throw new LanError("请先选择电脑", 401);
		const identity = (this.identity ??= await this.identityStore.load());
		const live = await this.ensureConnected();
		if (this.pending.size >= PENDING_LIMIT) throw new LanError("请求过于频繁，请稍后再试", 429);
		const request: RelayRequest = {
			id: crypto.randomUUID(),
			method: data === undefined ? "GET" : "POST",
			path,
			...(data === undefined ? {} : { body: data as Record<string, unknown> }),
		};
		const payload = await encryptRelayJson(
			live.key,
			request,
			relayAad(live.connectionId, binding.desktop.id, identity.id, "mobile-to-desktop"),
		);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(request.id)) reject(new LanError("请求超时，请检查电脑连接"));
			}, REQUEST_TIMEOUT_MS);
			(timer as unknown as { unref?: () => void }).unref?.();
			this.pending.set(request.id, { resolve: resolve as (body: unknown) => void, reject, timer });
			try {
				if (this.live !== live || live.socket.readyState !== 1) throw new LanError("连接中断");
				live.socket.send(JSON.stringify({ type: "frame", payload }));
			} catch (cause) {
				if (this.pending.delete(request.id)) {
					clearTimeout(timer);
					reject(cause instanceof Error ? cause : new LanError("连接中断"));
				}
			}
		});
	}

	private async submit<T>(path: string, payload: Record<string, unknown>): Promise<T> {
		let saved: { path: string; payload: Record<string, unknown>; requestId: string } | null = null;
		try {
			saved = JSON.parse((await this.preferences.get({ key: "pending-message" })).value ?? "null");
		} catch {
			// discard corrupt draft
		}
		const submission =
			saved?.path === path && JSON.stringify(saved.payload) === JSON.stringify(payload)
				? saved
				: { path, payload, requestId: crypto.randomUUID() };
		await this.preferences.set({ key: "pending-message", value: JSON.stringify(submission) });
		const result = await this.request<T>(path, { ...payload, requestId: submission.requestId });
		await this.preferences.remove({ key: "pending-message" });
		return result;
	}

	state() {
		return this.request<LanState>("/api/state");
	}
	defaults(projectId: string) {
		return this.request<AgentDefaults>(`/api/projects/${encodeURIComponent(projectId)}/defaults`);
	}
	snapshot(id: string) {
		return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}`);
	}
	delta(id: string, options: DeltaRequest = {}) {
		return this.request<AgentSnapshotDelta>(`/api/tasks/${encodeURIComponent(id)}/delta`, options);
	}
	toolOutput(id: string, toolCallId: string, offset: number) {
		return this.request<ToolOutputChunk>(`/api/tasks/${encodeURIComponent(id)}/tool-output`, { toolCallId, offset });
	}
	create(projectId: string, text: string, options: LanTaskOptions) {
		return this.submit<SubmitResult>("/api/tasks", { projectId, text, options });
	}
	send(id: string, text: string) {
		return this.submit<SendPromptResult>(`/api/tasks/${encodeURIComponent(id)}/send`, { text });
	}
	configure(id: string, options: LanTaskOptions) {
		return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/configure`, options);
	}
	abort(id: string) {
		return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/abort`, {});
	}
	answer(id: string, answer: WorkflowAnswer) {
		return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/answer`, answer);
	}
	cancelWorker(id: string, workerId: string) {
		return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/cancel-worker`, { id: workerId });
	}
	commands(id: string) {
		return this.request<SlashCommandSummary[]>(`/api/tasks/${encodeURIComponent(id)}/commands`);
	}
}

export const relay = new RelayClient();
