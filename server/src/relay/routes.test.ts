import { afterEach, describe, expect, test } from "bun:test";
import { createECDH, createHash } from "node:crypto";
import { SignJWT } from "jose";
import { Elysia } from "elysia";
import type { Database, RelayDeviceDoc } from "../db";
import type { Env } from "../env";
import { relayRoutes } from "./routes";

const SECRET = "test-secret-that-is-long-enough-32";

class FakeDevices {
	docs: RelayDeviceDoc[] = [];

	findOne(filter: Record<string, unknown>): Promise<RelayDeviceDoc | null> {
		return Promise.resolve(this.docs.find((doc) => Object.entries(filter).every(([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v)) ?? null);
	}

	updateOne(
		filter: Record<string, unknown>,
		update: Record<string, unknown>,
		options?: { upsert?: boolean },
	): Promise<{ modifiedCount: number; upsertedCount: number }> {
		const doc = this.docs.find((candidate) => Object.entries(filter).every(([k, v]) => (candidate as unknown as Record<string, unknown>)[k] === v));
		if (doc) {
			Object.assign(doc, update.$set as Record<string, unknown>);
			for (const key of Object.keys((update.$unset as Record<string, unknown>) ?? {})) delete (doc as unknown as Record<string, unknown>)[key];
			return Promise.resolve({ modifiedCount: 1, upsertedCount: 0 });
		}
		if (!options?.upsert) return Promise.resolve({ modifiedCount: 0, upsertedCount: 0 });
		this.docs.push({ ...filter, ...(update.$setOnInsert as Record<string, unknown>), ...(update.$set as Record<string, unknown>) } as unknown as RelayDeviceDoc);
		return Promise.resolve({ modifiedCount: 0, upsertedCount: 1 });
	}

	deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
		const index = this.docs.findIndex((doc) => Object.entries(filter).every(([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v));
		if (index < 0) return Promise.resolve({ deletedCount: 0 });
		this.docs.splice(index, 1);
		return Promise.resolve({ deletedCount: 1 });
	}

	find(filter: Record<string, unknown>) {
		const rows = this.docs.filter((doc) => Object.entries(filter).every(([k, v]) => (doc as unknown as Record<string, unknown>)[k] === v));
		return {
			sort: (spec: Record<string, 1 | -1>) => {
				const [field, direction] = Object.entries(spec)[0] as [keyof RelayDeviceDoc, 1 | -1];
				rows.sort((a, b) => ((a[field] as Date).getTime() - (b[field] as Date).getTime()) * direction);
				return {
					limit: (n: number) => ({ toArray: () => Promise.resolve(rows.slice(0, n)) }),
				};
			},
		};
	}
}

async function accessToken(userId: string): Promise<string> {
	return new SignJWT({ email: `${userId}@example.com` })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(userId)
		.setIssuer("nekocode")
		.setAudience("nekocode-app")
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + 900)
		.sign(new TextEncoder().encode(SECRET));
}

function deviceKey(): { id: string; publicKey: string } {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const raw = ecdh.getPublicKey(null, "uncompressed");
	return { id: createHash("sha256").update(raw).digest("hex"), publicKey: raw.toString("base64url") };
}

type Message = Record<string, unknown>;

class Client {
	readonly ws: WebSocket;
	private queue: Message[] = [];
	private closeEvent: { code: number; reason: string } | null = null;
	private messageWaiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void; timer: ReturnType<typeof setTimeout> }> = [];
	private closeWaiters: Array<{ resolve: (c: { code: number; reason: string }) => void; timer: ReturnType<typeof setTimeout> }> = [];

	constructor(private readonly url: string) {
		this.ws = new WebSocket(url);
		this.ws.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as Message;
			const index = this.messageWaiters.findIndex((waiter) => waiter.pred(message));
			if (index >= 0) {
				const [waiter] = this.messageWaiters.splice(index, 1);
				clearTimeout(waiter!.timer);
				waiter!.resolve(message);
			} else {
				this.queue.push(message);
			}
		};
		this.ws.onclose = (event) => {
			this.closeEvent = { code: event.code, reason: event.reason };
			for (const waiter of this.closeWaiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.resolve(this.closeEvent);
			}
		};
	}

	open(): Promise<void> {
		if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("open timeout")), 2000);
			this.ws.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			this.ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("socket failed"));
			};
		});
	}

	send(value: unknown): void {
		this.ws.send(JSON.stringify(value));
	}

	waitFor(pred: (m: Message) => boolean): Promise<Message> {
		const index = this.queue.findIndex(pred);
		if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]!);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.messageWaiters = this.messageWaiters.filter((waiter) => waiter.resolve !== resolve);
				reject(new Error("waitFor timeout"));
			}, 2000);
			this.messageWaiters.push({ pred, resolve, timer });
		});
	}

	waitClose(): Promise<{ code: number; reason: string }> {
		if (this.closeEvent) return Promise.resolve(this.closeEvent);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.closeWaiters = this.closeWaiters.filter((waiter) => waiter.resolve !== resolve);
				reject(new Error("waitClose timeout"));
			}, 2000);
			this.closeWaiters.push({ resolve, timer });
		});
	}

	close(): void {
		for (const waiter of this.messageWaiters.splice(0)) clearTimeout(waiter.timer);
		for (const waiter of this.closeWaiters.splice(0)) clearTimeout(waiter.timer);
		try {
			this.ws.close();
		} catch {}
	}
}

const apps: Array<{ stop: () => Promise<unknown> }> = [];
const clients: Client[] = [];

async function fixture() {
	const devices = new FakeDevices();
	const db = { devices } as unknown as Database;
	const env = { jwtSecret: SECRET } as Env;
	const app = new Elysia({ websocket: { maxPayloadLength: 2 * 1024 * 1024, idleTimeout: 45 } })
		.use(relayRoutes({ db, env }))
		.listen({ port: 0, hostname: "127.0.0.1" });
	apps.push(app);
	const port = app.server!.port;
	return {
		devices,
		port,
		http: `http://127.0.0.1:${port}`,
		ws: (path: string) => `ws://127.0.0.1:${port}${path}`,
	};
}

function client(url: string): Client {
	const c = new Client(url);
	clients.push(c);
	return c;
}

afterEach(async () => {
	for (const c of clients.splice(0)) c.close();
	for (const app of apps.splice(0)) await app.stop();
});

const FRAME = { version: 1, iv: "AQIDBAUGBwgJCgsM", data: "b3BhcXVlLWJ5dGVzLW5vdC1qc29u" };

describe("relay routes over real WebSockets", () => {
	test("desktop hello, device list, mobile pairing and opaque frame forwarding", async () => {
		const f = await fixture();
		const desktopDevice = deviceKey();
		const desktop = client(f.ws("/relay/desktop"));
		await desktop.open();
		desktop.send({
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			device: { id: desktopDevice.id, name: "Work PC", publicKey: desktopDevice.publicKey },
		});
		expect(await desktop.waitFor((m) => m.type === "ready")).toEqual({ type: "ready" });
		expect(f.devices.docs).toHaveLength(1);
		expect(f.devices.docs[0]!._id).toBe(desktopDevice.id);

		const listResponse = await fetch(`${f.http}/relay/devices`, { headers: { Authorization: `Bearer ${await accessToken("user-1")}` } });
		expect(listResponse.status).toBe(200);
		const list = (await listResponse.json()) as { devices: Array<{ id: string; name: string; online: boolean }> };
		expect(list.devices).toHaveLength(1);
		expect(list.devices[0]).toMatchObject({ id: desktopDevice.id, name: "Work PC", online: true });

		const mobilePeer = deviceKey();
		const mobile = client(f.ws("/relay/mobile"));
		await mobile.open();
		mobile.send({
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			desktopId: desktopDevice.id,
			peer: { id: mobilePeer.id, publicKey: mobilePeer.publicKey },
		});
		const ready = await mobile.waitFor((m) => m.type === "ready");
		expect(ready.connectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(ready.desktop).toEqual({ id: desktopDevice.id, name: "Work PC", publicKey: desktopDevice.publicKey });
		expect(await desktop.waitFor((m) => m.type === "peer")).toEqual({
			type: "peer",
			connectionId: ready.connectionId,
			peer: { id: mobilePeer.id, publicKey: mobilePeer.publicKey },
		});

		mobile.send({ type: "frame", payload: FRAME });
		expect(await desktop.waitFor((m) => m.type === "frame")).toEqual({ type: "frame", connectionId: ready.connectionId, payload: FRAME });

		desktop.send({ type: "frame", connectionId: ready.connectionId, payload: FRAME });
		expect(await mobile.waitFor((m) => m.type === "frame")).toEqual({ type: "frame", payload: FRAME });

		const intruder = client(f.ws("/relay/mobile"));
		await intruder.open();
		intruder.send({
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-2"),
			desktopId: desktopDevice.id,
			peer: deviceKey(),
		});
		expect(await intruder.waitFor((m) => m.type === "error")).toMatchObject({ code: "forbidden" });
		expect((await intruder.waitClose()).code).toBe(4403);

		const malformed = client(f.ws("/relay/desktop"));
		await malformed.open();
		malformed.ws.send("not json at all");
		expect((await malformed.waitClose()).code).toBe(4400);
	});

	test("DELETE /relay/devices/:id kicks the live sockets and empties the list", async () => {
		const f = await fixture();
		const desktopDevice = deviceKey();
		const desktop = client(f.ws("/relay/desktop"));
		await desktop.open();
		desktop.send({
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			device: { id: desktopDevice.id, name: "Work PC", publicKey: desktopDevice.publicKey },
		});
		await desktop.waitFor((m) => m.type === "ready");

		const mobilePeer = deviceKey();
		const mobile = client(f.ws("/relay/mobile"));
		await mobile.open();
		mobile.send({
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			desktopId: desktopDevice.id,
			peer: { id: mobilePeer.id, publicKey: mobilePeer.publicKey },
		});
		await mobile.waitFor((m) => m.type === "ready");

		const unauthorized = await fetch(`${f.http}/relay/devices/${desktopDevice.id}`, { method: "DELETE" });
		expect(unauthorized.status).toBe(401);
		const badId = await fetch(`${f.http}/relay/devices/nope`, { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken("user-1")}` } });
		expect(badId.status).toBe(400);

		const response = await fetch(`${f.http}/relay/devices/${desktopDevice.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken("user-1")}` } });
		expect(response.status).toBe(204);
		expect(f.devices.docs).toHaveLength(0);
		expect(await mobile.waitFor((m) => m.type === "error")).toMatchObject({ code: "desktop_offline" });
		expect((await desktop.waitClose()).code).toBe(4002);
		expect((await mobile.waitClose()).code).toBe(4404);

		const listResponse = await fetch(`${f.http}/relay/devices`, { headers: { Authorization: `Bearer ${await accessToken("user-1")}` } });
		expect(((await listResponse.json()) as { devices: unknown[] }).devices).toHaveLength(0);
	});
});
