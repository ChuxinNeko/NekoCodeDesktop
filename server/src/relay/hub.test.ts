import { describe, expect, test } from "bun:test";
import { createECDH, createHash } from "node:crypto";
import { SignJWT } from "jose";
import type { Database, RelayDeviceDoc } from "../db";
import { RelayHub, type RelaySocket } from "./hub";

const SECRET = "test-secret-that-is-long-enough-32";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket implements RelaySocket {
	sent: Array<Record<string, unknown>> = [];
	closed: { code: number; reason: string } | null = null;
	constructor(readonly id: string) {}
	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}
	close(code: number, reason: string): void {
		this.closed = { code, reason };
	}
	last(): Record<string, unknown> | undefined {
		return this.sent[this.sent.length - 1];
	}
}

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

function fixture() {
	const devices = new FakeDevices();
	const db = { devices } as unknown as Database;
	const hub = new RelayHub({ db, secret: SECRET });
	return { hub, devices };
}

async function accessToken(userId: string, ttlSeconds = 900): Promise<string> {
	return new SignJWT({ email: `${userId}@example.com` })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(userId)
		.setIssuer("nekocode")
		.setAudience("nekocode-app")
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
		.sign(new TextEncoder().encode(SECRET));
}

function deviceKey(): { id: string; publicKey: string } {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const raw = ecdh.getPublicKey(null, "uncompressed");
	return { id: createHash("sha256").update(raw).digest("hex"), publicKey: raw.toString("base64url") };
}

async function desktopOnline(hub: RelayHub, userId: string, name = "Work PC") {
	const socket = new FakeSocket(`d-${Math.random().toString(36).slice(2)}`);
	const device = deviceKey();
	await hub.desktopMessage(socket, {
		type: "hello",
		protocol: 1,
		accessToken: await accessToken(userId),
		device: { id: device.id, name, publicKey: device.publicKey },
	});
	return { socket, device };
}

async function mobileOnline(hub: RelayHub, userId: string, desktopId: string) {
	const socket = new FakeSocket(`m-${Math.random().toString(36).slice(2)}`);
	const peer = deviceKey();
	await hub.mobileMessage(socket, {
		type: "hello",
		protocol: 1,
		accessToken: await accessToken(userId),
		desktopId,
		peer: { id: peer.id, publicKey: peer.publicKey },
	});
	return { socket, peer };
}

const FRAME = { version: 1, iv: "AQIDBAUGBwgJCgsM", data: "b3BhcXVlLWJ5dGVzLW5vdC1qc29u" };

describe("desktop hello", () => {
	test("registers the device, answers ready, and lists it online only for its owner", async () => {
		const { hub, devices } = await (async () => {
			const f = fixture();
			const { socket, device } = await desktopOnline(f.hub, "user-1", "  My PC  ");
			expect(socket.sent).toEqual([{ type: "ready" }]);
			expect(f.devices.docs).toHaveLength(1);
			const doc = f.devices.docs[0]!;
			expect(doc._id).toBe(device.id);
			expect(doc.userId).toBe("user-1");
			expect(doc.name).toBe("My PC");
			expect(doc.publicKey).toBe(device.publicKey);
			expect(doc.createdAt).toBeInstanceOf(Date);
			expect(doc.lastSeenAt).toBeInstanceOf(Date);
			return { hub: f.hub, devices: f.devices, device };
		})();

		const own = await hub.listDevices("user-1");
		expect(own).toHaveLength(1);
		expect(own[0]).toMatchObject({ id: devices.docs[0]!._id, name: "My PC", publicKey: devices.docs[0]!.publicKey, online: true });
		expect(own[0]!.lastSeenAt).toBe(devices.docs[0]!.lastSeenAt.toISOString());
		expect(await hub.listDevices("user-2")).toHaveLength(0);
	});

	test("a reconnecting device replaces the old socket and the stale close cannot evict it", async () => {
		const f = fixture();
		const first = await desktopOnline(f.hub, "user-1");
		const second = new FakeSocket("d-second");
		await f.hub.desktopMessage(second, {
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			device: { id: first.device.id, name: "My PC", publicKey: first.device.publicKey },
		});
		expect(first.socket.closed).toEqual({ code: 4001, reason: "连接已被新的桌面会话替换" });
		expect(second.last()).toEqual({ type: "ready" });
		await f.hub.close(first.socket.id);
		expect((await f.hub.listDevices("user-1"))[0]!.online).toBe(true);
		await f.hub.mobileMessage(new FakeSocket("m-1"), { type: "ping" });
	});

	test("reconnecting a device drops its stale mobiles instead of rebinding them silently", async () => {
		const f = fixture();
		const first = await desktopOnline(f.hub, "user-1");
		const mobile = await mobileOnline(f.hub, "user-1", first.device.id);
		const staleConnection = mobile.socket.sent.find((m) => m.type === "ready")!.connectionId as string;

		const second = new FakeSocket("d-second");
		await f.hub.desktopMessage(second, {
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			device: { id: first.device.id, name: "Work PC", publicKey: first.device.publicKey },
		});
		expect(second.last()).toEqual({ type: "ready" });
		expect(first.socket.closed?.code).toBe(4001);
		expect(mobile.socket.last()).toMatchObject({ type: "error", code: "desktop_offline" });
		expect(mobile.socket.closed?.code).toBe(4404);

		await f.hub.desktopMessage(second, { type: "frame", connectionId: staleConnection, payload: FRAME });
		expect(second.closed?.code).toBe(4400);

		const replacement = await mobileOnline(f.hub, "user-1", first.device.id);
		expect(replacement.socket.last()).toMatchObject({ type: "ready" });
	});
});

describe("mobile hello and frames", () => {
	test("same-account mobile pairs with the desktop and ciphertext passes through untouched", async () => {
		const f = fixture();
		const desktop = await desktopOnline(f.hub, "user-1");
		const mobile = await mobileOnline(f.hub, "user-1", desktop.device.id);

		const ready = mobile.socket.last()!;
		expect(ready.type).toBe("ready");
		expect(ready.connectionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(ready.desktop).toEqual({ id: desktop.device.id, name: "Work PC", publicKey: desktop.device.publicKey });

		const peer = desktop.socket.last()!;
		expect(peer).toEqual({ type: "peer", connectionId: ready.connectionId, peer: { id: mobile.peer.id, publicKey: mobile.peer.publicKey } });

		desktop.socket.sent.length = 0;
		await f.hub.mobileMessage(mobile.socket, { type: "frame", payload: FRAME });
		expect(desktop.socket.last()).toEqual({ type: "frame", connectionId: ready.connectionId, payload: FRAME });

		mobile.socket.sent.length = 0;
		await f.hub.desktopMessage(desktop.socket, { type: "frame", connectionId: ready.connectionId, payload: FRAME });
		expect(mobile.socket.last()).toEqual({ type: "frame", payload: FRAME });

		mobile.socket.sent.length = 0;
		desktop.socket.sent.length = 0;
		await f.hub.mobileMessage(mobile.socket, { type: "ping" });
		await f.hub.desktopMessage(desktop.socket, { type: "ping" });
		expect(mobile.socket.last()).toEqual({ type: "pong" });
		expect(desktop.socket.last()).toEqual({ type: "pong" });
	});
});

describe("rejection paths", () => {
	test("another user's desktop is forbidden, offline desktops are reported, bad shapes are protocol errors", async () => {
		const f = fixture();
		const desktop = await desktopOnline(f.hub, "user-1");

		const intruder = new FakeSocket("m-intruder");
		await f.hub.mobileMessage(intruder, {
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-2"),
			desktopId: desktop.device.id,
			peer: deviceKey(),
		});
		expect(intruder.last()).toMatchObject({ type: "error", code: "forbidden" });
		expect(intruder.closed?.code).toBe(4403);

		const ghost = deviceKey();
		f.devices.docs.push({
			_id: ghost.id,
			userId: "user-1",
			name: "Sleeping PC",
			publicKey: ghost.publicKey,
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		const lonely = new FakeSocket("m-lonely");
		await f.hub.mobileMessage(lonely, {
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			desktopId: ghost.id,
			peer: deviceKey(),
		});
		expect(lonely.last()).toMatchObject({ type: "error", code: "desktop_offline" });
		expect(lonely.closed?.code).toBe(4404);

		const missing = new FakeSocket("m-missing");
		await f.hub.mobileMessage(missing, {
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			desktopId: "0".repeat(64),
			peer: deviceKey(),
		});
		expect(missing.closed?.code).toBe(4403);

		const mismatched = new FakeSocket("m-mismatched");
		const key = deviceKey();
		await f.hub.mobileMessage(mismatched, {
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1"),
			desktopId: desktop.device.id,
			peer: { id: "f".repeat(64), publicKey: key.publicKey },
		});
		expect(mismatched.closed?.code).toBe(4400);

		const mobile = await mobileOnline(f.hub, "user-1", desktop.device.id);
		await f.hub.mobileMessage(mobile.socket, { type: "frame", payload: { version: 1, iv: "not a b64!!", data: FRAME.data } });
		expect(mobile.socket.closed?.code).toBe(4400);

		const early = new FakeSocket("m-early");
		await f.hub.mobileMessage(early, { type: "frame", payload: FRAME });
		expect(early.closed?.code).toBe(4400);
		await f.hub.desktopMessage(new FakeSocket("d-early"), { type: "ping" });
	});

	test("a mobile frame sent after its desktop mapping vanished is failed, not dropped", async () => {
		const f = fixture();
		const desktop = await desktopOnline(f.hub, "user-1");
		const mobile = await mobileOnline(f.hub, "user-1", desktop.device.id);
		const internals = f.hub as unknown as {
			desktops: Map<string, unknown>;
			desktopByDevice: Map<string, string>;
		};
		internals.desktops.delete(desktop.socket.id);
		internals.desktopByDevice.delete(desktop.device.id);

		await f.hub.mobileMessage(mobile.socket, { type: "frame", payload: FRAME });
		expect(mobile.socket.last()).toMatchObject({ type: "error", code: "desktop_offline" });
		expect(mobile.socket.closed?.code).toBe(4404);
		await f.hub.mobileMessage(mobile.socket, { type: "frame", payload: FRAME });
		expect(mobile.socket.last()).toMatchObject({ type: "error", code: "invalid_request" });
	});

	test("a desktop cannot push frames into another account's connection", async () => {
		const f = fixture();
		const victimDesktop = await desktopOnline(f.hub, "user-2");
		const victimMobile = await mobileOnline(f.hub, "user-2", victimDesktop.device.id);
		const foreignConnection = (victimMobile.socket.last()!.connectionId as string);

		const attacker = await desktopOnline(f.hub, "user-1");
		victimMobile.socket.sent.length = 0;
		await f.hub.desktopMessage(attacker.socket, { type: "frame", connectionId: foreignConnection, payload: FRAME });
		expect(attacker.socket.closed?.code).toBe(4400);
		expect(victimMobile.socket.sent).toHaveLength(0);
	});
});

describe("disconnects", () => {
	test("mobile close emits peer-closed, desktop close drops its mobiles and marks the device offline", async () => {
		const f = fixture();
		const desktop = await desktopOnline(f.hub, "user-1");
		const mobile = await mobileOnline(f.hub, "user-1", desktop.device.id);
		const connectionId = mobile.socket.sent.find((m) => m.type === "ready")!.connectionId as string;

		desktop.socket.sent.length = 0;
		await f.hub.close(mobile.socket.id);
		expect(desktop.socket.last()).toEqual({ type: "peer-closed", connectionId });

		const mobile2 = await mobileOnline(f.hub, "user-1", desktop.device.id);
		const seenBefore = f.devices.docs[0]!.lastSeenAt;
		await sleep(5);
		await f.hub.close(desktop.socket.id);
		expect(mobile2.socket.last()).toMatchObject({ type: "error", code: "desktop_offline" });
		expect(mobile2.socket.closed?.code).toBe(4404);
		expect(f.devices.docs[0]!.lastSeenAt.getTime()).toBeGreaterThan(seenBefore.getTime());
		expect((await f.hub.listDevices("user-1"))[0]!.online).toBe(false);
	});
});

describe("unregister", () => {
	test("the owner can detach a device, closing its socket and mobiles, while others cannot", async () => {
		const f = fixture();
		const desktop = await desktopOnline(f.hub, "user-1");
		const mobile = await mobileOnline(f.hub, "user-1", desktop.device.id);

		await f.hub.unregister("user-2", desktop.device.id);
		expect(f.devices.docs).toHaveLength(1);
		expect(desktop.socket.closed).toBeNull();
		expect((await f.hub.listDevices("user-1"))[0]!.online).toBe(true);

		await f.hub.unregister("user-1", desktop.device.id);
		expect(f.devices.docs).toHaveLength(0);
		expect(desktop.socket.closed).toEqual({ code: 4002, reason: "设备已从账号注销" });
		expect(mobile.socket.last()).toMatchObject({ type: "error", code: "desktop_offline" });
		expect(mobile.socket.closed?.code).toBe(4404);
		expect(await f.hub.listDevices("user-1")).toHaveLength(0);

		await f.hub.close(desktop.socket.id);
		expect(f.devices.docs).toHaveLength(0);
		await f.hub.unregister("user-1", desktop.device.id);
	});
});

describe("token enforcement", () => {
	test("invalid tokens are refused and expiring tokens close the socket on schedule", async () => {
		const f = fixture();
		const bad = new FakeSocket("d-bad");
		await f.hub.desktopMessage(bad, {
			type: "hello",
			protocol: 1,
			accessToken: "not-a-jwt",
			device: { ...deviceKey(), name: "PC" },
		});
		expect(bad.last()).toMatchObject({ type: "error", code: "unauthorized", message: "登录状态已失效" });
		expect(bad.closed?.code).toBe(4401);

		const short = new FakeSocket("d-short");
		const device = deviceKey();
		await f.hub.desktopMessage(short, {
			type: "hello",
			protocol: 1,
			accessToken: await accessToken("user-1", 1),
			device: { id: device.id, name: "PC", publicKey: device.publicKey },
		});
		expect(short.last()).toEqual({ type: "ready" });
		await sleep(1400);
		expect(short.last()).toMatchObject({ type: "error", code: "unauthorized" });
		expect(short.closed?.code).toBe(4401);
	});
});

describe("listDevices", () => {
	test("scopes to the owner, sorts by recency and caps at twenty", async () => {
		const f = fixture();
		const now = Date.now();
		for (let i = 0; i < 25; i++) {
			const key = deviceKey();
			f.devices.docs.push({
				_id: key.id,
				userId: "user-1",
				name: `PC ${i}`,
				publicKey: key.publicKey,
				createdAt: new Date(now),
				lastSeenAt: new Date(now + i * 1000),
			});
		}
		const other = deviceKey();
		f.devices.docs.push({
			_id: other.id,
			userId: "user-2",
			name: "Not yours",
			publicKey: other.publicKey,
			createdAt: new Date(now + 999_000),
			lastSeenAt: new Date(now + 999_000),
		});
		const list = await f.hub.listDevices("user-1");
		expect(list).toHaveLength(20);
		expect(list[0]!.name).toBe("PC 24");
		expect(list.every((d) => d.name !== "Not yours")).toBe(true);
	});
});
