import { createHash, randomUUID } from "node:crypto";
import { verifyAccess, type VerifiedAccessClaims } from "../auth/tokens";
import type { Database } from "../db";

export interface RelaySocket {
	id: string;
	send(data: string): unknown;
	close(code: number, reason: string): void;
}

export interface RelayHubDeps {
	db: Database;
	secret: string;
}

const ID_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 4096;
const MAX_KEY_LENGTH = 200;
const MAX_FRAME_DATA_LENGTH = 1_398_200;

interface DesktopConn {
	socket: RelaySocket;
	deviceId: string;
	userId: string;
	timer: ReturnType<typeof setTimeout>;
}

interface MobileConn {
	socket: RelaySocket;
	userId: string;
	desktopId: string;
	connectionId: string;
	timer: ReturnType<typeof setTimeout>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCiphertext(value: unknown): boolean {
	if (!isObject(value)) return false;
	return (
		value.version === 1 &&
		typeof value.iv === "string" &&
		value.iv.length > 0 &&
		value.iv.length <= 24 &&
		B64URL_PATTERN.test(value.iv) &&
		typeof value.data === "string" &&
		value.data.length > 0 &&
		value.data.length <= MAX_FRAME_DATA_LENGTH &&
		B64URL_PATTERN.test(value.data)
	);
}

function keyMatchesId(id: unknown, publicKey: unknown): boolean {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) return false;
	if (typeof publicKey !== "string" || publicKey.length > MAX_KEY_LENGTH || !B64URL_PATTERN.test(publicKey)) return false;
	const raw = Buffer.from(publicKey, "base64url");
	if (raw.length !== 65 || raw[0] !== 0x04) return false;
	return createHash("sha256").update(raw).digest("hex") === id;
}

export class RelayHub {
	private readonly desktops = new Map<string, DesktopConn>();
	private readonly desktopByDevice = new Map<string, string>();
	private readonly mobiles = new Map<string, MobileConn>();
	private readonly mobileByConn = new Map<string, string>();
	private readonly pending = new Set<string>();

	constructor(private readonly deps: RelayHubDeps) {}

	async desktopMessage(socket: RelaySocket, value: unknown): Promise<void> {
		try {
			await this.onDesktopMessage(socket, value);
		} catch {
			this.fail(socket, "server_error", "服务器出错了，请稍后再试", 1011);
		}
	}

	async mobileMessage(socket: RelaySocket, value: unknown): Promise<void> {
		try {
			await this.onMobileMessage(socket, value);
		} catch {
			this.fail(socket, "server_error", "服务器出错了，请稍后再试", 1011);
		}
	}

	async close(socketId: string): Promise<void> {
		this.pending.delete(socketId);
		const desktop = this.desktops.get(socketId);
		if (desktop) {
			this.desktops.delete(socketId);
			clearTimeout(desktop.timer);
			if (this.desktopByDevice.get(desktop.deviceId) === socketId) this.desktopByDevice.delete(desktop.deviceId);
			try {
				await this.deps.db.devices.updateOne(
					{ _id: desktop.deviceId, userId: desktop.userId },
					{ $set: { lastSeenAt: new Date() } },
				);
			} catch {}
			this.dropMobiles(desktop.deviceId, desktop.userId);
			return;
		}
		const mobile = this.mobiles.get(socketId);
		if (mobile) {
			this.mobiles.delete(socketId);
			this.mobileByConn.delete(mobile.connectionId);
			clearTimeout(mobile.timer);
			const desktopSocketId = this.desktopByDevice.get(mobile.desktopId);
			const target = desktopSocketId ? this.desktops.get(desktopSocketId) : undefined;
			if (target) this.send(target.socket, { type: "peer-closed", connectionId: mobile.connectionId });
		}
	}

	async unregister(userId: string, deviceId: string): Promise<void> {
		await this.deps.db.devices.deleteOne({ _id: deviceId, userId });
		const socketId = this.desktopByDevice.get(deviceId);
		const desktop = socketId ? this.desktops.get(socketId) : undefined;
		if (!socketId || !desktop || desktop.userId !== userId) return;
		this.desktops.delete(socketId);
		this.desktopByDevice.delete(deviceId);
		clearTimeout(desktop.timer);
		this.dropMobiles(deviceId, userId);
		this.shutdown(desktop.socket, 4002, "设备已从账号注销");
	}

	async listDevices(
		userId: string,
	): Promise<Array<{ id: string; name: string; publicKey: string; lastSeenAt: string; online: boolean }>> {
		const docs = await this.deps.db.devices.find({ userId }).sort({ lastSeenAt: -1 }).limit(20).toArray();
		return docs.map((doc) => {
			const socketId = this.desktopByDevice.get(doc._id);
			const online = socketId !== undefined && this.desktops.get(socketId)?.userId === userId;
			return { id: doc._id, name: doc.name, publicKey: doc.publicKey, lastSeenAt: doc.lastSeenAt.toISOString(), online };
		});
	}

	private async onDesktopMessage(socket: RelaySocket, value: unknown): Promise<void> {
		if (this.pending.has(socket.id)) return this.protocolError(socket);
		const desktop = this.desktops.get(socket.id);
		if (!desktop) {
			if (!isObject(value) || value.type !== "hello") return this.protocolError(socket);
			return this.desktopHello(socket, value);
		}
		if (!isObject(value)) return this.protocolError(socket);
		if (value.type === "ping") {
			this.send(socket, { type: "pong" });
			return;
		}
		if (value.type === "frame") {
			const connectionId = value.connectionId;
			if (typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId) || !isCiphertext(value.payload)) {
				return this.protocolError(socket);
			}
			const mobileSocketId = this.mobileByConn.get(connectionId);
			const mobile = mobileSocketId ? this.mobiles.get(mobileSocketId) : undefined;
			if (!mobile || mobile.desktopId !== desktop.deviceId || mobile.userId !== desktop.userId) {
				return this.protocolError(socket);
			}
			this.send(mobile.socket, { type: "frame", payload: value.payload });
			return;
		}
		return this.protocolError(socket);
	}

	private async onMobileMessage(socket: RelaySocket, value: unknown): Promise<void> {
		if (this.pending.has(socket.id)) return this.protocolError(socket);
		const mobile = this.mobiles.get(socket.id);
		if (!mobile) {
			if (!isObject(value) || value.type !== "hello") return this.protocolError(socket);
			return this.mobileHello(socket, value);
		}
		if (!isObject(value)) return this.protocolError(socket);
		if (value.type === "ping") {
			this.send(socket, { type: "pong" });
			return;
		}
		if (value.type === "frame") {
			if (!isCiphertext(value.payload)) return this.protocolError(socket);
			const desktopSocketId = this.desktopByDevice.get(mobile.desktopId);
			const target = desktopSocketId ? this.desktops.get(desktopSocketId) : undefined;
			if (!target || target.userId !== mobile.userId) {
				this.mobiles.delete(socket.id);
				this.mobileByConn.delete(mobile.connectionId);
				clearTimeout(mobile.timer);
				return this.fail(mobile.socket, "desktop_offline", "桌面端不在线", 4404);
			}
			this.send(target.socket, { type: "frame", connectionId: mobile.connectionId, payload: value.payload });
			return;
		}
		return this.protocolError(socket);
	}

	private async desktopHello(socket: RelaySocket, value: Record<string, unknown>): Promise<void> {
		this.pending.add(socket.id);
		try {
			const token = value.accessToken;
			const device = value.device;
			if (
				value.protocol !== 1 ||
				typeof token !== "string" ||
				token.length === 0 ||
				token.length > MAX_TOKEN_LENGTH ||
				!isObject(device) ||
				typeof device.name !== "string" ||
				device.name.trim().length === 0 ||
				device.name.trim().length > 60 ||
				!keyMatchesId(device.id, device.publicKey)
			) {
				return this.protocolError(socket);
			}
			const claims = await verifyAccess(token, this.deps.secret);
			if (!claims) return this.fail(socket, "unauthorized", "登录状态已失效", 4401);
			const existing = await this.deps.db.devices.findOne({ _id: device.id as string });
			if (existing && existing.userId !== claims.userId) {
				return this.fail(socket, "forbidden", "设备不属于当前账号", 4403);
			}
			const now = new Date();
			try {
				await this.deps.db.devices.updateOne(
					{ _id: device.id as string },
					{
						$set: { userId: claims.userId, name: (device.name as string).trim(), publicKey: device.publicKey as string, lastSeenAt: now },
						$setOnInsert: { createdAt: now },
					},
					{ upsert: true },
				);
			} catch {
				return this.fail(socket, "server_error", "服务器出错了，请稍后再试", 1011);
			}
			const previousSocketId = this.desktopByDevice.get(device.id as string);
			if (previousSocketId && previousSocketId !== socket.id) {
				const previous = this.desktops.get(previousSocketId);
				if (previous) {
					this.dropMobiles(previous.deviceId, previous.userId);
					this.desktops.delete(previousSocketId);
					clearTimeout(previous.timer);
					this.shutdown(previous.socket, 4001, "连接已被新的桌面会话替换");
				}
			}
			this.desktops.set(socket.id, {
				socket,
				deviceId: device.id as string,
				userId: claims.userId,
				timer: this.expiryTimer(socket, claims),
			});
			this.desktopByDevice.set(device.id as string, socket.id);
			this.send(socket, { type: "ready" });
		} finally {
			this.pending.delete(socket.id);
		}
	}

	private async mobileHello(socket: RelaySocket, value: Record<string, unknown>): Promise<void> {
		this.pending.add(socket.id);
		try {
			const token = value.accessToken;
			const peer = value.peer;
			if (
				value.protocol !== 1 ||
				typeof token !== "string" ||
				token.length === 0 ||
				token.length > MAX_TOKEN_LENGTH ||
				typeof value.desktopId !== "string" ||
				!ID_PATTERN.test(value.desktopId) ||
				!isObject(peer) ||
				!keyMatchesId(peer.id, peer.publicKey)
			) {
				return this.protocolError(socket);
			}
			const claims = await verifyAccess(token, this.deps.secret);
			if (!claims) return this.fail(socket, "unauthorized", "登录状态已失效", 4401);
			const desktopId = value.desktopId;
			const device = await this.deps.db.devices.findOne({ _id: desktopId, userId: claims.userId });
			if (!device) return this.fail(socket, "forbidden", "设备不存在或不属于当前账号", 4403);
			const desktopSocketId = this.desktopByDevice.get(desktopId);
			const desktop = desktopSocketId ? this.desktops.get(desktopSocketId) : undefined;
			if (!desktop || desktop.userId !== claims.userId) {
				return this.fail(socket, "desktop_offline", "桌面端不在线", 4404);
			}
			const connectionId = randomUUID();
			this.mobiles.set(socket.id, {
				socket,
				userId: claims.userId,
				desktopId,
				connectionId,
				timer: this.expiryTimer(socket, claims),
			});
			this.mobileByConn.set(connectionId, socket.id);
			this.send(desktop.socket, { type: "peer", connectionId, peer: { id: peer.id as string, publicKey: peer.publicKey as string } });
			this.send(socket, {
				type: "ready",
				connectionId,
				desktop: { id: device._id, name: device.name, publicKey: device.publicKey },
			});
		} finally {
			this.pending.delete(socket.id);
		}
	}

	private dropMobiles(desktopId: string, userId: string): void {
		for (const [socketId, mobile] of [...this.mobiles]) {
			if (mobile.desktopId !== desktopId || mobile.userId !== userId) continue;
			this.mobiles.delete(socketId);
			this.mobileByConn.delete(mobile.connectionId);
			clearTimeout(mobile.timer);
			this.fail(mobile.socket, "desktop_offline", "桌面端不在线", 4404);
		}
	}

	private expiryTimer(socket: RelaySocket, claims: VerifiedAccessClaims): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			this.fail(socket, "unauthorized", "登录状态已失效", 4401);
		}, Math.max(0, claims.expiresAt - Date.now()));
		timer.unref?.();
		return timer;
	}

	private send(socket: RelaySocket, value: unknown): void {
		try {
			socket.send(JSON.stringify(value));
		} catch {}
	}

	private shutdown(socket: RelaySocket, code: number, reason: string): void {
		try {
			socket.close(code, reason);
		} catch {}
	}

	private fail(socket: RelaySocket, code: string, message: string, closeCode: number): void {
		this.send(socket, { type: "error", code, message });
		this.shutdown(socket, closeCode, message);
	}

	private protocolError(socket: RelaySocket): void {
		this.fail(socket, "invalid_request", "中继协议错误", 4400);
	}
}
