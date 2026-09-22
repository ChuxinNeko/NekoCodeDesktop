import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayRequest, RelayStatus } from "../shared/relay";
import { decryptRelayJson, deriveRelayKey, encryptRelayJson, generateRelayIdentity, relayAad } from "../shared/relay-crypto";
import type { LanService } from "./lan-service";
import { RelayCredentialStore } from "./relay-credential-store";
import { RelayService, type RelayServiceDeps } from "./relay-service";

const dirs: string[] = [];
const services: RelayService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	readonly sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(code = 1000, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	message(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
	serverClose(code: number, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
	last(): Record<string, unknown> {
		return JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
	}
}

function fakeEncryption() {
	return {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "kwallet6" as const,
		encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
		decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
	};
}

interface FetchCall {
	url: string;
	method: string;
	body: unknown;
	token?: string;
}

function fakeFetch(routes: Record<string, { status: number; body: unknown } | (() => { status: number; body: unknown })>) {
	const calls: FetchCall[] = [];
	const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
		const path = String(url).replace("https://codeapi.nekofun.top", "");
		const key = path in routes ? path : Object.keys(routes).find((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));
		const route = key ? routes[key] : undefined;
		const respond = typeof route === "function" ? route() : route;
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			...(headers.authorization ? { token: headers.authorization.replace(/^Bearer /, "") } : {}),
		});
		if (!respond) throw new TypeError("fetch failed");
		return {
			ok: respond.status >= 200 && respond.status < 300,
			status: respond.status,
			json: async () => respond.body,
		} as Response;
	};
	return { calls, fetchImpl: fetchImpl as typeof globalThis.fetch };
}

const TOKENS = {
	status: 200,
	body: { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900, user: { id: "user-1", email: "neko@example.com" } },
};

function fixture(
	routes: Record<string, { status: number; body: unknown } | (() => { status: number; body: unknown })> = {},
	respond?: (request: RelayRequest) => unknown,
) {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-relay-test-"));
	dirs.push(dir);
	const encryption = fakeEncryption();
	const gatewayCalls: Array<{ peerId: string; request: RelayRequest }> = [];
	const gateway = {
		handleRelay: async (peerId: string, request: RelayRequest) => {
			gatewayCalls.push({ peerId, request });
			return { id: request.id, status: 200, body: respond ? respond(request) : { echo: request } };
		},
	} as unknown as Pick<LanService, "handleRelay">;
	const statuses: RelayStatus[] = [];
	const { calls, fetchImpl } = fakeFetch(routes);
	const deps: RelayServiceDeps = {
		userDataDir: dir,
		encryption,
		gateway,
		emit: (status) => statuses.push(status),
		fetch: fetchImpl,
		webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
		deviceName: () => "Test PC",
	};
	const service = new RelayService(deps);
	services.push(service);
	return {
		service, dir, calls, gatewayCalls, statuses,
		lastStatus: () => statuses[statuses.length - 1]!,
		store: () => new RelayCredentialStore(dir, encryption),
	};
}

async function signedIn(
	routes: Record<string, { status: number; body: unknown } | (() => { status: number; body: unknown })> = {},
	respond?: (request: RelayRequest) => unknown,
) {
	const f = fixture({ "/auth/login": TOKENS, ...routes }, respond);
	await f.service.login({ email: "  Neko@Example.com ", password: "secret-password" });
	const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	ws.open();
	await sleep(10);
	return { ...f, ws };
}

describe("RelayService login", () => {
	test("posts credentials, stores the session encrypted and sends hello without secrets", async () => {
		const f = await signedIn();
		expect(f.calls[0]).toMatchObject({ url: "https://codeapi.nekofun.top/auth/login", method: "POST", body: { email: "Neko@Example.com", password: "secret-password" } });
		expect(f.lastStatus().account).toEqual({ email: "neko@example.com" });
		expect(f.lastStatus().state).toBe("connecting");

		const hello = f.ws.last();
		expect(hello.type).toBe("hello");
		expect(hello.accessToken).toBe("access-1");
		expect(JSON.stringify(hello)).not.toContain("secret-password");
		expect(JSON.stringify(hello)).not.toContain("refresh-1");

		const raw = readFileSync(join(f.dir, "relay-credentials.json"), "utf8");
		expect(raw).not.toContain("access-1");
		expect(raw).not.toContain("refresh-1");

		f.ws.message({ type: "ready" });
		await sleep(5);
		expect(f.lastStatus().state).toBe("ready");
		expect(JSON.stringify(f.lastStatus())).not.toContain("access-1");
		expect(JSON.stringify(f.lastStatus())).not.toContain("refresh-1");
		const identity = await f.store().identity();
		expect(JSON.stringify(f.lastStatus())).not.toContain(identity.privateKey);
	});

	test("login refuses to hit the network when the keyring is unavailable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nekocode-relay-test-"));
		dirs.push(dir);
		const { calls, fetchImpl } = fakeFetch({ "/auth/login": TOKENS });
		const insecure = { ...fakeEncryption(), isEncryptionAvailable: () => false };
		const service = new RelayService({
			userDataDir: dir,
			encryption: insecure,
			gateway: { handleRelay: async () => ({ id: "x", status: 200, body: null }) } as never,
			emit: () => undefined,
			fetch: fetchImpl,
			webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
		});
		services.push(service);
		await expect(service.login({ email: "neko@example.com", password: "pw" })).rejects.toThrow("系统密钥环不可用，无法安全保存公网连接凭据");
		expect(calls).toHaveLength(0);
	});
});

describe("RelayService registration", () => {
	test("register posts the trimmed email without storing a session or dialling", async () => {
		const f = fixture({ "/auth/register": { status: 200, body: { ok: true, next: "verify" } } });
		const sockets = FakeWebSocket.instances.length;
		await f.service.register({ email: "  New@Example.com ", password: "password-123" });
		expect(f.calls[0]).toMatchObject({
			url: "https://codeapi.nekofun.top/auth/register",
			method: "POST",
			body: { email: "New@Example.com", password: "password-123" },
		});
		expect(f.store().account()).toBeNull();
		expect(FakeWebSocket.instances.length).toBe(sockets);
		expect(JSON.stringify(f.service.status())).not.toContain("password-123");
		const credentials = join(f.dir, "relay-credentials.json");
		if (existsSync(credentials)) {
			expect(readFileSync(credentials, "utf8")).not.toContain("password-123");
		}
	});

	test("register refuses to hit the network when the keyring is unavailable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nekocode-relay-test-"));
		dirs.push(dir);
		const { calls, fetchImpl } = fakeFetch({ "/auth/register": { status: 200, body: { ok: true } } });
		const insecure = { ...fakeEncryption(), isEncryptionAvailable: () => false };
		const service = new RelayService({
			userDataDir: dir,
			encryption: insecure,
			gateway: { handleRelay: async () => ({ id: "x", status: 200, body: null }) } as never,
			emit: () => undefined,
			fetch: fetchImpl,
			webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
		});
		services.push(service);
		await expect(service.register({ email: "neko@example.com", password: "password-123" })).rejects.toThrow("系统密钥环不可用，无法安全保存公网连接凭据");
		expect(calls).toHaveLength(0);
	});

	test("verify posts the trimmed credentials, stores the session and dials", async () => {
		const f = fixture({ "/auth/verify": TOKENS });
		const status = await f.service.verify({ email: "  Neko@Example.com ", code: " 123456 " });
		expect(f.calls[0]).toMatchObject({
			url: "https://codeapi.nekofun.top/auth/verify",
			method: "POST",
			body: { email: "Neko@Example.com", code: "123456" },
		});
		expect(status.account).toEqual({ email: "neko@example.com" });
		expect(status.state).toBe("connecting");
		expect(f.store().account()?.refreshToken).toBe("refresh-1");
		const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		ws.open();
		await sleep(10);
		expect(ws.last().accessToken).toBe("access-1");
		const raw = readFileSync(join(f.dir, "relay-credentials.json"), "utf8");
		expect(raw).not.toContain("access-1");
		expect(raw).not.toContain("refresh-1");
		expect(JSON.stringify(status)).not.toContain("access-1");
	});

	test("a malformed verify response is rejected without a session or dial", async () => {
		const f = fixture({ "/auth/verify": { status: 200, body: { nope: true } } });
		const sockets = FakeWebSocket.instances.length;
		await expect(f.service.verify({ email: "neko@example.com", code: "123456" })).rejects.toThrow("服务器返回了无法识别的登录响应");
		expect(f.store().account()).toBeNull();
		expect(FakeWebSocket.instances.length).toBe(sockets);
	});

	test("resend posts the trimmed email and a structured register error reaches the caller", async () => {
		const f = fixture({
			"/auth/resend": { status: 204, body: null },
			"/auth/register": { status: 409, body: { error: { code: "email_taken", message: "邮箱已被注册" } } },
		});
		const sockets = FakeWebSocket.instances.length;
		await f.service.resend({ email: "  New@Example.com " });
		expect(f.calls[0]).toMatchObject({
			url: "https://codeapi.nekofun.top/auth/resend",
			method: "POST",
			body: { email: "New@Example.com" },
		});
		expect(f.store().account()).toBeNull();
		expect(FakeWebSocket.instances.length).toBe(sockets);
		await expect(f.service.register({ email: "neko@example.com", password: "password-123" })).rejects.toThrow("邮箱已被注册");
	});
});

describe("RelayService frames", () => {
	const CONN = "123e4567-e89b-42d3-a456-426614174000";

	async function peered(respond?: (request: RelayRequest) => unknown) {
		const f = await signedIn({}, respond);
		f.ws.message({ type: "ready" });
		const desktop = await f.store().identity();
		const mobile = await generateRelayIdentity();
		const mobileKey = await deriveRelayKey(mobile, desktop.publicKey);
		f.ws.message({ type: "peer", connectionId: CONN, peer: { id: mobile.id, publicKey: mobile.publicKey } });
		return { ...f, desktop, mobile, mobileKey };
	}

	test("a peer frame is decrypted, dispatched and answered end-to-end", async () => {
		const f = await peered();
		const request: RelayRequest = { id: "relay-request-12345", method: "POST", path: "/api/tasks", body: { text: "帮我修这个 bug" } };
		const payload = await encryptRelayJson(f.mobileKey, request, relayAad(CONN, f.desktop.id, f.mobile.id, "mobile-to-desktop"));
		f.ws.message({ type: "frame", connectionId: CONN, payload });
		await sleep(20);

		expect(f.gatewayCalls).toEqual([{ peerId: f.mobile.id, request }]);
		const frame = f.ws.last();
		expect(frame.type).toBe("frame");
		expect(frame.connectionId).toBe(CONN);
		const reply = await decryptRelayJson<{ id: string; status: number; body: unknown }>(
			f.mobileKey,
			frame.payload as never,
			relayAad(CONN, f.desktop.id, f.mobile.id, "desktop-to-mobile"),
		);
		expect(reply).toEqual({ id: request.id, status: 200, body: { echo: request } });
	});

	test("a response too large for the relay comes back as an error, not silence", async () => {
		// The phone is waiting on this request id; dropping the frame would leave it
		// to sit there until its own timeout with nothing to explain the wait.
		const f = await peered(() => ({ transcript: "x".repeat(2 * 1024 * 1024) }));
		const request: RelayRequest = { id: "relay-request-12345", method: "GET", path: "/api/tasks/big" };
		const payload = await encryptRelayJson(f.mobileKey, request, relayAad(CONN, f.desktop.id, f.mobile.id, "mobile-to-desktop"));
		f.ws.message({ type: "frame", connectionId: CONN, payload });
		await sleep(20);

		const frame = f.ws.last();
		expect(frame.type).toBe("frame");
		const reply = await decryptRelayJson<{ id: string; status: number; body: { error: string } }>(
			f.mobileKey,
			frame.payload as never,
			relayAad(CONN, f.desktop.id, f.mobile.id, "desktop-to-mobile"),
		);
		expect(reply.id).toBe(request.id);
		expect(reply.status).toBe(502);
		expect(reply.body.error).toContain("过大");
	});

	test("a frame arriving right after peer still resolves the key", async () => {
		const f = await signedIn();
		f.ws.message({ type: "ready" });
		const desktop = await f.store().identity();
		const mobile = await generateRelayIdentity();
		const mobileKey = await deriveRelayKey(mobile, desktop.publicKey);
		const request: RelayRequest = { id: "relay-request-99999", method: "GET", path: "/api/state" };
		const payload = await encryptRelayJson(mobileKey, request, relayAad(CONN, desktop.id, mobile.id, "mobile-to-desktop"));
		f.ws.message({ type: "peer", connectionId: CONN, peer: { id: mobile.id, publicKey: mobile.publicKey } });
		f.ws.message({ type: "frame", connectionId: CONN, payload });
		await sleep(20);
		expect(f.gatewayCalls).toEqual([{ peerId: mobile.id, request }]);
	});

	test("a peer whose id does not match its public key never becomes usable", async () => {
		const f = await peered();
		const stranger = await generateRelayIdentity();
		const CONN2 = "323e4567-e89b-42d3-a456-426614174000";
		f.ws.message({ type: "peer", connectionId: CONN2, peer: { id: f.mobile.id, publicKey: stranger.publicKey } });
		const request: RelayRequest = { id: "relay-request-55555", method: "GET", path: "/api/state" };
		const strangerKey = await deriveRelayKey(stranger, f.desktop.publicKey);
		const payload = await encryptRelayJson(strangerKey, request, relayAad(CONN2, f.desktop.id, f.mobile.id, "mobile-to-desktop"));
		f.ws.message({ type: "frame", connectionId: CONN2, payload });
		await sleep(30);
		expect(f.gatewayCalls).toHaveLength(0);
		expect(f.ws.readyState).toBe(1);
	});

	test("a tampered or unknown frame is ignored without killing the desktop socket", async () => {
		const f = await peered();
		const request: RelayRequest = { id: "relay-request-12345", method: "GET", path: "/api/state" };
		const good = await encryptRelayJson(f.mobileKey, request, relayAad(CONN, f.desktop.id, f.mobile.id, "mobile-to-desktop"));
		const flipped = good.data[0] === "A" ? "B" : "A";
		const tampered = { ...good, data: flipped + good.data.slice(1) };
		f.ws.message({ type: "frame", connectionId: CONN, payload: tampered });
		f.ws.message({ type: "frame", connectionId: "223e4567-e89b-42d3-a456-426614174000", payload: good });
		await sleep(20);
		expect(f.gatewayCalls).toHaveLength(0);
		expect(f.ws.readyState).toBe(1);
	});
});

describe("RelayService token lifecycle", () => {
	test("a near-expiry access token refreshes once before hello", async () => {
		const f = fixture({
			"/auth/refresh": { status: 200, body: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900, user: { id: "user-1", email: "neko@example.com" } } },
		});
		f.store().writeAccount({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 30_000, user: { id: "user-1", email: "neko@example.com" } });
		await f.service.start();
		const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		ws.open();
		await sleep(10);
		expect(f.calls.filter((c) => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
		expect(ws.last().accessToken).toBe("access-2");
		expect(f.store().account()!.refreshToken).toBe("refresh-2");
	});

	test("a refused refresh signs out and stops dialling", async () => {
		const f = fixture({ "/auth/refresh": { status: 401, body: { error: { code: "unauthorized", message: "登录状态已失效，请重新登录" } } } });
		f.store().writeAccount({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 30_000, user: { id: "user-1", email: "neko@example.com" } });
		await f.service.start();
		FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.open();
		await sleep(10);
		expect(f.lastStatus().state).toBe("signed-out");
		expect(f.lastStatus().account).toBeNull();
		expect(f.store().account()).toBeNull();
	});

	test("a refresh response for a different account signs out", async () => {
		const f = fixture({
			"/auth/refresh": { status: 200, body: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900, user: { id: "user-2", email: "neko@example.com" } } },
		});
		f.store().writeAccount({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 30_000, user: { id: "user-1", email: "neko@example.com" } });
		await f.service.start();
		FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.open();
		await sleep(10);
		expect(f.lastStatus().state).toBe("signed-out");
		expect(f.store().account()).toBeNull();
	});

	test("a network refresh failure keeps the session", async () => {
		const f = fixture({});
		f.store().writeAccount({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 30_000, user: { id: "user-1", email: "neko@example.com" } });
		await f.service.start();
		FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.open();
		await sleep(10);
		expect(f.store().account()).not.toBeNull();
		expect(f.lastStatus().account).toEqual({ email: "neko@example.com" });
	});
});

describe("RelayService logout", () => {
	test("unregisters the device, posts logout and clears credentials", async () => {
		const f = await signedIn({ "/auth/logout": { status: 204, body: null }, "/relay/devices/*": { status: 204, body: null } });
		f.ws.message({ type: "ready" });
		const identity = await f.store().identity();
		const status = await f.service.logout();
		expect(status.state).toBe("signed-out");
		expect(f.store().account()).toBeNull();
		const remove = f.calls.find((c) => c.method === "DELETE")!;
		expect(remove.url).toBe(`https://codeapi.nekofun.top/relay/devices/${identity.id}`);
		expect(remove.token).toBe("access-1");
		expect(f.calls.find((c) => c.url.endsWith("/auth/logout"))?.body).toEqual({ refreshToken: "refresh-1" });
	});

	test("logout after a token rotation unregisters and signs out with the fresh tokens", async () => {
		const f = fixture({
			"/auth/refresh": { status: 200, body: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900, user: { id: "user-1", email: "neko@example.com" } } },
			"/relay/devices/*": { status: 204, body: null },
			"/auth/logout": { status: 204, body: null },
		});
		f.store().writeAccount({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 30_000, user: { id: "user-1", email: "neko@example.com" } });
		await f.service.start();
		const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		ws.open();
		await sleep(10);
		const identity = await f.store().identity();

		const status = await f.service.logout();
		expect(status.state).toBe("signed-out");
		expect(f.store().account()).toBeNull();
		const refresh = f.calls.find((c) => c.url.endsWith("/auth/refresh"))!;
		const remove = f.calls.find((c) => c.method === "DELETE")!;
		const signout = f.calls.find((c) => c.url.endsWith("/auth/logout"))!;
		expect(refresh.body).toEqual({ refreshToken: "refresh-1" });
		expect(remove.url).toBe(`https://codeapi.nekofun.top/relay/devices/${identity.id}`);
		expect(remove.token).toBe("access-2");
		expect(signout.body).toEqual({ refreshToken: "refresh-2" });
		expect(f.calls.indexOf(refresh)).toBeLessThan(f.calls.indexOf(remove));
		expect(f.calls.indexOf(remove)).toBeLessThan(f.calls.indexOf(signout));
	});

	test("a failed unregister keeps the account and resumes the connection", async () => {
		const f = await signedIn();
		f.ws.message({ type: "ready" });
		const before = FakeWebSocket.instances.length;
		f.calls.length = 0;
		await expect(f.service.logout()).rejects.toThrow();
		expect(f.store().account()).not.toBeNull();
		expect(FakeWebSocket.instances.length).toBe(before + 1);
	});
});

describe("RelayService reconnect and shutdown", () => {
	test("an unexpected close backs off and redials, 4403 does not", async () => {
		const f = await signedIn();
		f.ws.message({ type: "ready" });
		f.ws.serverClose(1006, "lost");
		expect(f.lastStatus().state).toBe("error");
		const count = FakeWebSocket.instances.length;
		await sleep(1_300);
		expect(FakeWebSocket.instances.length).toBe(count + 1);

		const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		ws2.open();
		await sleep(5);
		ws2.serverClose(4403, "forbidden");
		expect(f.lastStatus()).toMatchObject({ state: "error", error: "设备已绑定其他账号，请先用原账号注销" });
		const after = FakeWebSocket.instances.length;
		await sleep(1_300);
		expect(FakeWebSocket.instances.length).toBe(after);
	});

	test("a 4401 close forces a token refresh on the next dial", async () => {
		const f = await signedIn({
			"/auth/refresh": { status: 200, body: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900, user: { id: "user-1", email: "neko@example.com" } } },
		});
		f.ws.message({ type: "ready" });
		f.ws.serverClose(4401, "登录状态已失效");
		expect(f.store().account()!.expiresAt).toBe(0);
		const count = FakeWebSocket.instances.length;
		await sleep(1_300);
		const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		expect(FakeWebSocket.instances.length).toBe(count + 1);
		ws2.open();
		await sleep(10);
		expect(f.calls.find((c) => c.url.endsWith("/auth/refresh"))?.body).toEqual({ refreshToken: "refresh-1" });
		expect(ws2.last().accessToken).toBe("access-2");
	});

	test("stale sockets cannot drive state, peers or the gateway", async () => {
		const f = await signedIn();
		f.ws.message({ type: "ready" });
		const stale = f.ws;
		await f.service.reconnect();
		expect(f.lastStatus().state).toBe("connecting");

		stale.message({ type: "ready" });
		stale.message({ type: "peer", connectionId: "123e4567-e89b-42d3-a456-426614174000", peer: { id: "0".repeat(64), publicKey: "invalid" } });
		stale.message({ type: "frame", connectionId: "123e4567-e89b-42d3-a456-426614174000", payload: { version: 1, iv: "AQIDBAUGBwgJCgsM", data: "b3BhcXVl" } });
		await sleep(20);
		expect(f.lastStatus().state).toBe("connecting");
		expect(f.gatewayCalls).toHaveLength(0);
	});

	test("reconnect redials immediately and close stops everything", async () => {
		const f = await signedIn();
		f.ws.message({ type: "ready" });
		const count = FakeWebSocket.instances.length;
		await f.service.reconnect();
		expect(FakeWebSocket.instances.length).toBe(count + 1);
		expect(f.lastStatus().state).toBe("connecting");

		f.service.close();
		FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.serverClose(1006, "lost");
		const after = FakeWebSocket.instances.length;
		await sleep(1_300);
		expect(FakeWebSocket.instances.length).toBe(after);
	});
});
