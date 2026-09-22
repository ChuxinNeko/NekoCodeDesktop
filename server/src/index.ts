import { Elysia } from "elysia";
import { authRoutes } from "./auth/routes";
import { connect } from "./db";
import { loadEnv } from "./env";
import { fail } from "./errors";
import { createMailer } from "./mail/mailer";
import { relayRoutes } from "./relay/routes";

const env = loadEnv();
const db = await connect(env.mongoUri, env.mongoDb);
const mailer = createMailer(env);

const app = new Elysia({
	websocket: {
		maxPayloadLength: 2 * 1024 * 1024,
		idleTimeout: 45,
		backpressureLimit: 2 * 1024 * 1024,
		closeOnBackpressureLimit: true,
	},
})
	.onError(({ code, error, set }) => {
		// Validation failures are the client's problem and safe to describe;
		// anything else is logged here and described to the caller only in general
		// terms, because a stack trace is a map of the server.
		if (code === "VALIDATION") {
			set.status = 400;
			return fail("invalid_request", "请求参数不正确");
		}
		if (code === "NOT_FOUND") {
			set.status = 404;
			return fail("invalid_request", "接口不存在");
		}
		console.error("[error]", code, error instanceof Error ? error.message : error);
		set.status = 500;
		return fail("server_error", "服务器出错了，请稍后再试");
	})
	.get("/health", () => ({ ok: true, at: new Date().toISOString() }))
	.use(authRoutes({ db, env, mailer }))
	.use(relayRoutes({ db, env }))
	.listen({ port: env.port, hostname: env.bindHost });

console.log(`NekoCode server listening on ${env.bindHost}:${String(env.port)}`);

/**
 * Close the database and the mail pool before exiting.
 *
 * Without this a container restart leaves the mail server holding connections
 * that only time out minutes later, and a pool that small notices.
 */
async function shutdown(signal: string): Promise<void> {
	console.log(`\n${signal}, shutting down`);
	await app.stop();
	await mailer.close();
	await db.close();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
