/**
 * Configuration, read once and validated at boot.
 *
 * Fails fast and by name: a public service that starts with a missing JWT
 * secret and only finds out on the first login has already accepted traffic it
 * cannot serve. Every secret comes from the environment — nothing in this
 * repository holds a real credential.
 */

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`缺少环境变量 ${name}，请参考 server/.env.example`);
	return value;
}

function optional(name: string, fallback: string): string {
	return process.env[name]?.trim() || fallback;
}

function integer(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`环境变量 ${name} 必须是正整数`);
	return value;
}

/** Shortest secret worth calling one: 256 bits of base64 is 43 characters. */
const MIN_SECRET_LENGTH = 32;

export interface Env {
	port: number;
	/**
	 * Interface to bind.
	 *
	 * Loopback by default, because this runs behind nginx and the IP rate limiter
	 * trusts `x-forwarded-for`. Binding every interface would leave the app
	 * directly reachable on its port, where that header is whatever the caller
	 * types — so the reverse proxy would be a suggestion rather than the only way
	 * in. Set `0.0.0.0` only if something else is enforcing that.
	 */
	bindHost: string;
	mongoUri: string;
	mongoDb: string;
	/** Signs access tokens and HMACs verification codes at rest. */
	jwtSecret: string;
	accessTokenTtlSeconds: number;
	refreshTokenTtlSeconds: number;
	smtp: {
		host: string;
		port: number;
		user: string;
		pass: string;
		/** Envelope sender, e.g. `NekoCode <noreply@nekofun.top>`. */
		from: string;
		/**
		 * Accept a certificate the system cannot verify.
		 *
		 * Off by default. A self-hosted mail server behind a self-signed
		 * certificate is the one case this exists for, and turning it on means
		 * the connection is encrypted but not authenticated.
		 */
		allowSelfSigned: boolean;
	};
}

export function loadEnv(): Env {
	const jwtSecret = required("JWT_SECRET");
	if (jwtSecret.length < MIN_SECRET_LENGTH) {
		throw new Error(`JWT_SECRET 至少需要 ${String(MIN_SECRET_LENGTH)} 个字符，请用 openssl rand -base64 48 生成`);
	}
	return {
		port: integer("PORT", 3000),
		bindHost: optional("BIND_HOST", "127.0.0.1"),
		mongoUri: required("MONGODB_URI"),
		mongoDb: optional("MONGODB_DB", "nekocode"),
		jwtSecret,
		accessTokenTtlSeconds: integer("ACCESS_TOKEN_TTL", 15 * 60),
		refreshTokenTtlSeconds: integer("REFRESH_TOKEN_TTL", 30 * 24 * 60 * 60),
		smtp: {
			host: required("SMTP_HOST"),
			port: integer("SMTP_PORT", 465),
			user: required("SMTP_USER"),
			pass: required("SMTP_PASS"),
			from: optional("SMTP_FROM", `NekoCode <${required("SMTP_USER")}>`),
			allowSelfSigned: process.env.SMTP_ALLOW_SELF_SIGNED === "true",
		},
	};
}
