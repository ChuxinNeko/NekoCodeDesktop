import { afterEach, expect, test } from "bun:test";
import type { RelayCiphertext, RelayDeviceSummary, RelayRequest, RelayResponse } from "../../src/shared/relay";
import {
	deriveRelayKey,
	decryptRelayJson,
	encryptRelayJson,
	generateRelayIdentity,
	relayAad,
	relayPublicId,
} from "../../src/shared/relay-crypto";
import { LanError } from "./lan-client";
import { RelayClient, type RelayAccountLike } from "./relay-client";
import type { PreferencesLike } from "./relay-identity";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONN = "123e4567-e89b-42d3-a456-426614174000";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readonly sent: string[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	message(value: unknown) {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
	serverClose(code: number, reason = "") {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
	send(data: string) {
		this.sent.push(data);
	}
	close(code: number, reason: string) {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
	last<T = Record<string, unknown>>(): T {
		return JSON.parse(this.sent[this.sent.length - 1]!) as T;
	}
}

function fakePreferences(): PreferencesLike & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		get: async ({ key }) => ({ value: data.get(key) ?? null }),
		set: async ({ key, value }) => { data.set(key, value); },
		remove: async ({ key }) => { data.delete(key); },
	};
}

const clients: RelayClient[] = [];
afterEach(() => {
	for (const client of clients) void client.disconnect();
	FakeWebSocket.instances = [];
});

async function device(name = "工作台"): Promise<{ summary: RelayDeviceSummary; identity: Awaited<ReturnType<typeof generateRelayIdentity>> }> {
	const identity = await generateRelayIdentity();
	return { identity, summary: { id: identity.id, name, publicKey: identity.publicKey, lastSeenAt: new Date().toISOString(), online: true } };
}

function fixture(account?: Partial<RelayAccountLike>) {
	FakeWebSocket.instances = [];
	const preferences = fakePreferences();
	const devices: RelayDeviceSummary[] = [];
	const fakeAccount: RelayAccountLike = {
		email: "neko@example.com",
		relayAccess: async () => ({ accessToken: "access-1", expiresAt: Date.now() + 600_000 }),
		relayDevices: async () => devices,
		...account,
	};
	const client = new RelayClient({
		account: fakeAccount,
		preferences,
		webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
		endpoint: "wss://relay.test/relay/mobile",
	});
	clients.push(client);
	return { client, preferences, devices, account: fakeAccount };
}

async function bound() {
	const f = fixture();
	const { summary, identity: desktop } = await device();
	f.devices.push(summary);
	await f.client.restore();
	await f.client.select(summary);
	return { ...f, desktop };
}

async function connected() {
	const f = await bound();
	const state = f.client.state();
	await sleep(1);
	const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	ws.open();
	await sleep(1);
	ws.message({ type: "ready", connectionId: CONN, desktop: { id: f.desktop.id, name: "工作台", publicKey: f.desktop.publicKey } });
	await sleep(5);
	const mobileIdentity = await import("./relay-identity").then(({ MobileRelayIdentityStore }) => new MobileRelayIdentityStore(f.preferences).load());
	const key = await deriveRelayKey(f.desktop, mobileIdentity.publicKey);
	const frame = ws.last<{ payload: RelayCiphertext }>().payload;
	const request = await decryptRelayJson<RelayRequest>(key, frame, relayAad(CONN, f.desktop.id, mobileIdentity.id, "mobile-to-desktop"));
	ws.message({ type: "frame", payload: await encryptRelayJson(key, { id: request.id, status: 200, body: { tasks: [], projects: [] } }, relayAad(CONN, f.desktop.id, mobileIdentity.id, "desktop-to-mobile")) });
	const result = await state;
	return { ...f, ws, key, mobileIdentity, hello: ws.sent[0] ? (JSON.parse(ws.sent[0]) as Record<string, unknown>) : null, result };
}

test("restore keeps the binding only for the same account and an honest fingerprint", async () => {
	const { client, preferences } = fixture();
	const { summary } = await device();
	await client.select(summary);
	expect(client.binding?.desktop.id).toBe(summary.id);

	const sameAccount = new RelayClient({ account: { email: "NEKO@example.com", relayAccess: async () => ({ accessToken: "t", expiresAt: 0 }), relayDevices: async () => [] }, preferences, webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket, endpoint: "wss://x" });
	clients.push(sameAccount);
	expect((await sameAccount.restore())?.desktop.id).toBe(summary.id);

	const otherAccount = new RelayClient({ account: { email: "other@example.com", relayAccess: async () => ({ accessToken: "t", expiresAt: 0 }), relayDevices: async () => [] }, preferences, webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket, endpoint: "wss://x" });
	clients.push(otherAccount);
	expect(await otherAccount.restore()).toBeNull();
	expect(preferences.data.get("relay-desktop-binding")).not.toBeNull();

	const stranger = await generateRelayIdentity();
	preferences.data.set("relay-desktop-binding", JSON.stringify({ accountEmail: "neko@example.com", desktop: { id: summary.id, name: "x", publicKey: stranger.publicKey } }));
	expect(await client.restore()).toBeNull();
});

test("listDevices rejects a server-substituted public key", async () => {
	const f = fixture();
	const { summary } = await device();
	const stranger = await generateRelayIdentity();
	f.devices.push({ ...summary, publicKey: stranger.publicKey });
	await expect(f.client.listDevices()).rejects.toMatchObject({ message: "设备公钥校验失败" });
});

test("hello carries only the access token and requests run end-to-end over E2E frames", async () => {
	const f = await connected();
	const hello = f.hello as { type: string; protocol: number; accessToken: string; desktopId: string; peer: { id: string; publicKey: string } };
	expect(hello.type).toBe("hello");
	expect(hello.protocol).toBe(1);
	expect(hello.accessToken).toBe("access-1");
	expect(hello.desktopId).toBe(f.desktop.id);
	expect(hello.peer.id).toBe(await relayPublicId(hello.peer.publicKey));
	expect(JSON.stringify(hello)).not.toContain("refresh");
	expect(JSON.stringify(hello)).not.toContain("password");

	expect(f.result).toBeTruthy();
	const frame = f.ws.last<{ type: string; payload: RelayCiphertext }>();
	expect(frame.type).toBe("frame");
	const mobileIdentity = await import("./relay-identity").then(({ MobileRelayIdentityStore }) => new MobileRelayIdentityStore(f.preferences).load());
	const key = await deriveRelayKey(f.desktop, mobileIdentity.publicKey);
	const request = await decryptRelayJson<RelayRequest>(key, frame.payload, relayAad(CONN, f.desktop.id, mobileIdentity.id, "mobile-to-desktop"));
	expect(request.method).toBe("GET");
	expect(request.path).toBe("/api/state");

	const send = f.client.send("task-1", "继续做");
	await sleep(1);
	const requestFrame = f.ws.last<{ payload: RelayCiphertext }>();
	const outgoing = await decryptRelayJson<RelayRequest>(key, requestFrame.payload, relayAad(CONN, f.desktop.id, mobileIdentity.id, "mobile-to-desktop"));
	expect(outgoing.method).toBe("POST");
	expect(outgoing.path).toBe("/api/tasks/task-1/send");
	expect(outgoing.body?.text).toBe("继续做");
	const response: RelayResponse = { id: outgoing.id, status: 200, body: { accepted: true } };
	f.ws.message({ type: "frame", payload: await encryptRelayJson(key, response, relayAad(CONN, f.desktop.id, mobileIdentity.id, "desktop-to-mobile")) });
	expect(await send).toEqual({ accepted: true });
});

test("error responses become LanError and unknown ids do not disturb other pendings", async () => {
	const f = await connected();
	const mobileIdentity = await import("./relay-identity").then(({ MobileRelayIdentityStore }) => new MobileRelayIdentityStore(f.preferences).load());
	const key = await deriveRelayKey(f.desktop, mobileIdentity.publicKey);

	const first = f.client.snapshot("task-1");
	const second = f.client.state();
	await sleep(1);
	const requests = f.ws.sent.slice(-2).map((raw) => (JSON.parse(raw) as { payload: RelayCiphertext }).payload);
	const ids = await Promise.all(requests.map((payload) => decryptRelayJson<RelayRequest>(key, payload, relayAad(CONN, f.desktop.id, mobileIdentity.id, "mobile-to-desktop")).then((r) => r.id)));
	const aad = relayAad(CONN, f.desktop.id, mobileIdentity.id, "desktop-to-mobile");
	f.ws.message({ type: "frame", payload: await encryptRelayJson(key, { id: "not-a-pending-id", status: 200, body: {} }, aad) });
	f.ws.message({ type: "frame", payload: await encryptRelayJson(key, { id: ids[0], status: 404, body: { error: "任务不存在" } }, aad) });
	await expect(first).rejects.toMatchObject({ message: "任务不存在", status: 404 });
	f.ws.message({ type: "frame", payload: await encryptRelayJson(key, { id: ids[1], status: 200, body: { tasks: [], projects: [] } }, aad) });
	expect(await second).toEqual({ tasks: [], projects: [] });
});

test("server close codes map to LanError, pendings reject, and the next request dials again", async () => {
	const f = await connected();
	const stuck = f.client.snapshot("later");
	await sleep(1);
	f.ws.message({ type: "error", code: "desktop_offline", message: "桌面端不在线" });
	f.ws.serverClose(4404, "桌面端不在线");
	await expect(stuck).rejects.toMatchObject({ status: 503 });

	const again = f.client.state();
	await sleep(1);
	const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	expect(ws2).not.toBe(f.ws);
	ws2.open();
	await sleep(1);
	ws2.message({ type: "ready", connectionId: "223e4567-e89b-42d3-a456-426614174000", desktop: { id: f.desktop.id, name: "工作台", publicKey: f.desktop.publicKey } });
	await sleep(5);
	const againRequest = await decryptRelayJson<RelayRequest>(f.key, ws2.last<{ payload: RelayCiphertext }>().payload, relayAad("223e4567-e89b-42d3-a456-426614174000", f.desktop.id, f.mobileIdentity.id, "mobile-to-desktop"));
	ws2.message({ type: "frame", payload: await encryptRelayJson(f.key, { id: againRequest.id, status: 200, body: { tasks: [], projects: [] } }, relayAad("223e4567-e89b-42d3-a456-426614174000", f.desktop.id, f.mobileIdentity.id, "desktop-to-mobile")) });
	expect(await again).toEqual({ tasks: [], projects: [] });

	const stale = f.client.state();
	await sleep(1);
	FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.serverClose(4401, "登录状态已失效");
	await expect(stale).rejects.toMatchObject({ status: 401 });
});

test("a tampered frame is dropped without killing the connection and a forged ready is refused", async () => {
	const f = await connected();
	const mobileIdentity = await import("./relay-identity").then(({ MobileRelayIdentityStore }) => new MobileRelayIdentityStore(f.preferences).load());
	const key = await deriveRelayKey(f.desktop, mobileIdentity.publicKey);
	const aad = relayAad(CONN, f.desktop.id, mobileIdentity.id, "desktop-to-mobile");
	const good = await encryptRelayJson(key, { id: "x", status: 200, body: null }, aad);
	const flipped = good.data[0] === "A" ? "B" : "A";
	f.ws.message({ type: "frame", payload: { ...good, data: flipped + good.data.slice(1) } });
	expect(f.ws.readyState).toBe(1);

	const pending = f.client.state();
	await sleep(1);
	const request = await decryptRelayJson<RelayRequest>(key, f.ws.last<{ payload: RelayCiphertext }>().payload, relayAad(CONN, f.desktop.id, mobileIdentity.id, "mobile-to-desktop"));
	f.ws.message({ type: "frame", payload: await encryptRelayJson(key, { id: request.id, status: 200, body: { tasks: [], projects: [] } }, aad) });
	expect(await pending).toEqual({ tasks: [], projects: [] });
});

test("a ready for a different desktop is rejected", async () => {
	const f = await bound();
	const state = f.client.state();
	await sleep(1);
	const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	ws.open();
	await sleep(1);
	const stranger = await generateRelayIdentity();
	ws.message({ type: "ready", connectionId: CONN, desktop: { id: stranger.id, name: "x", publicKey: stranger.publicKey } });
	await expect(state).rejects.toThrow();
});

test("disconnecting mid-handshake closes the socket and rejects the request", async () => {
	const f = await bound();
	const pending = f.client.state();
	await sleep(1);
	const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	await f.client.disconnect();
	expect(ws.readyState).toBe(3);
	await expect(pending).rejects.toThrow();
});

test("a stale socket's late close cannot touch the new connection", async () => {
	const f = await connected();
	const stale = f.ws;
	await f.client.disconnect();
	const again = f.client.state();
	await sleep(1);
	const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	ws2.open();
	await sleep(1);
	ws2.message({ type: "ready", connectionId: "323e4567-e89b-42d3-a456-426614174000", desktop: { id: f.desktop.id, name: "工作台", publicKey: f.desktop.publicKey } });
	await sleep(5);
	stale.serverClose(4401, "登录状态已失效");
	const request = await decryptRelayJson<RelayRequest>(f.key, ws2.last<{ payload: RelayCiphertext }>().payload, relayAad("323e4567-e89b-42d3-a456-426614174000", f.desktop.id, f.mobileIdentity.id, "mobile-to-desktop"));
	ws2.message({ type: "frame", payload: await encryptRelayJson(f.key, { id: request.id, status: 200, body: { tasks: [], projects: [] } }, relayAad("323e4567-e89b-42d3-a456-426614174000", f.desktop.id, f.mobileIdentity.id, "desktop-to-mobile")) });
	expect(await again).toEqual({ tasks: [], projects: [] });
	expect(ws2.readyState).toBe(1);
});

test("selecting a different device abandons an in-flight handshake", async () => {
	const f = await bound();
	const pending = f.client.state().catch((cause: unknown) => cause);
	await sleep(1);
	const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	const other = await device("另一台电脑");
	await f.client.select(other.summary);
	expect(ws.readyState).toBe(3);
	expect(await pending).toBeInstanceOf(Error);
	expect(f.client.binding?.desktop.id).toBe(other.summary.id);
});

test("a 4401 close forces a token refresh on the next dial", async () => {
	const accessCalls: Array<boolean | undefined> = [];
	const f = fixture({
		relayAccess: async (forceRefresh?: boolean) => {
			accessCalls.push(forceRefresh);
			return { accessToken: forceRefresh ? "access-2" : "access-1", expiresAt: Date.now() + 600_000 };
		},
	});
	const { summary, identity: desktop } = await device();
	f.devices.push(summary);
	await f.client.restore();
	await f.client.select(summary);
	const first = f.client.state();
	await sleep(1);
	const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	ws.open();
	await sleep(1);
	ws.message({ type: "ready", connectionId: CONN, desktop: { id: desktop.id, name: "工作台", publicKey: desktop.publicKey } });
	await sleep(5);
	ws.serverClose(4401, "登录状态已失效");
	await expect(first).rejects.toMatchObject({ status: 401 });

	void f.client.state().catch(() => null);
	await sleep(1);
	const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	expect(ws2).not.toBe(ws);
	expect(accessCalls[accessCalls.length - 1]).toBe(true);
	ws2.open();
	await sleep(1);
	expect((JSON.parse(ws2.sent[0]!) as { accessToken: string }).accessToken).toBe("access-2");
});

test("disconnecting while the access token is awaited never creates a socket", async () => {
	const releases: Array<(value: { accessToken: string; expiresAt: number }) => void> = [];
	const f = fixture({ relayAccess: () => new Promise((resolve) => { releases.push(resolve); }) });
	const { summary, identity: desktop } = await device();
	f.devices.push(summary);
	await f.client.restore();
	await f.client.select(summary);

	const pending = f.client.state().catch((cause: unknown) => cause);
	await sleep(1);
	expect(releases).toHaveLength(1);
	await f.client.disconnect();
	releases[0]!({ accessToken: "access-1", expiresAt: Date.now() + 600_000 });
	await sleep(5);
	expect(FakeWebSocket.instances).toHaveLength(0);
	expect(await pending).toBeInstanceOf(Error);

	const next = f.client.state();
	await sleep(1);
	expect(releases).toHaveLength(2);
	releases[1]!({ accessToken: "access-1", expiresAt: Date.now() + 600_000 });
	await sleep(1);
	const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	ws.open();
	await sleep(1);
	ws.message({ type: "ready", connectionId: CONN, desktop: { id: desktop.id, name: "工作台", publicKey: desktop.publicKey } });
	await sleep(5);
	const mobileIdentity = await import("./relay-identity").then(({ MobileRelayIdentityStore }) => new MobileRelayIdentityStore(f.preferences).load());
	const key = await deriveRelayKey(desktop, mobileIdentity.publicKey);
	const request = await decryptRelayJson<RelayRequest>(key, ws.last<{ payload: RelayCiphertext }>().payload, relayAad(CONN, desktop.id, mobileIdentity.id, "mobile-to-desktop"));
	ws.message({ type: "frame", payload: await encryptRelayJson(key, { id: request.id, status: 200, body: { tasks: [], projects: [] } }, relayAad(CONN, desktop.id, mobileIdentity.id, "desktop-to-mobile")) });
	expect(await next).toEqual({ tasks: [], projects: [] });
});

test("two simultaneous requests share one socket, and forget clears the binding", async () => {
	const f = await connected();
	const first = f.client.state().catch(() => null);
	const second = f.client.snapshot("task-9").catch(() => null);
	await sleep(5);
	expect(FakeWebSocket.instances).toHaveLength(1);
	await f.client.forget();
	expect(f.client.binding).toBeNull();
	expect(f.preferences.data.get("relay-desktop-binding")).toBeUndefined();
	await expect(f.client.state()).rejects.toMatchObject({ status: 401 });
});
