import { Elysia } from "elysia";
import { verifyAccess } from "../auth/tokens";
import type { Database } from "../db";
import type { Env } from "../env";
import { fail } from "../errors";
import { RelayHub, type RelaySocket } from "./hub";

export function relayRoutes(deps: { db: Database; env: Env }) {
	const hub = new RelayHub({ db: deps.db, secret: deps.env.jwtSecret });
	const adapter = (ws: {
		id: string;
		send(data: unknown): unknown;
		close(code?: number, reason?: string): unknown;
	}): RelaySocket => ({
		id: ws.id,
		send: (data) => ws.send(data),
		close: (code, reason) => ws.close(code, reason),
	});
	const parse = (value: unknown): unknown => {
		if (typeof value !== "string") return value;
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	};

	return new Elysia()
		.get("/relay/devices", async ({ headers, set }) => {
			const header = headers.authorization;
			const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
			const claims = token ? await verifyAccess(token, deps.env.jwtSecret) : null;
			if (!claims) {
				set.status = 401;
				return fail("unauthorized", "请先登录");
			}
			return { devices: await hub.listDevices(claims.userId) };
		})
		.delete("/relay/devices/:id", async ({ params, headers, set }) => {
			const header = headers.authorization;
			const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
			const claims = token ? await verifyAccess(token, deps.env.jwtSecret) : null;
			if (!claims) {
				set.status = 401;
				return fail("unauthorized", "请先登录");
			}
			if (!/^[a-f0-9]{64}$/.test(params.id)) {
				set.status = 400;
				return fail("invalid_request", "设备编号不正确");
			}
			await hub.unregister(claims.userId, params.id);
			set.status = 204;
			return null;
		})
		.ws("/relay/desktop", {
			message(ws, value) {
				void hub.desktopMessage(adapter(ws), parse(value));
			},
			close(ws) {
				void hub.close(ws.id);
			},
		})
		.ws("/relay/mobile", {
			message(ws, value) {
				void hub.mobileMessage(adapter(ws), parse(value));
			},
			close(ws) {
				void hub.close(ws.id);
			},
		});
}
