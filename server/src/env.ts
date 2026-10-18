/**
 * Configuration, read once and validated at boot.
 *
 * Fails fast and by name: a public service that starts with a missing JWT
 * secret and only finds out on the first login has already accepted traffic it
 * cannot serve. Every secret comes from the environment — nothing in this
 * repository holds a real credential.
 */

import type { GitHubAppConfig } from "./github/service";

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
	/** Optional: GitHub endpoints return a configuration error until registered. */
	github?: GitHubAppConfig;
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

function githubConfig(): GitHubAppConfig | undefined {
	if (!["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_CALLBACK_URL", "GITHUB_APP_SLUG", "GITHUB_AUTH_ENCRYPTION_KEY"].some(name => process.env[name]?.trim())) return undefined;
	const callbackUrl = required("GITHUB_APP_CALLBACK_URL");
	const url = new URL(callbackUrl);
	if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("GITHUB_APP_CALLBACK_URL 必须是 HTTPS URL（本机开发可使用 HTTP）");
	const appSlug = required("GITHUB_APP_SLUG");
	if (!/^[a-z0-9-]+$/.test(appSlug)) throw new Error("GITHUB_APP_SLUG 格式不正确");
	const encryptionKey = required("GITHUB_AUTH_ENCRYPTION_KEY");
	if (encryptionKey.length < MIN_SECRET_LENGTH) throw new Error("GITHUB_AUTH_ENCRYPTION_KEY 至少需要 32 个字符");
	return { clientId: required("GITHUB_APP_CLIENT_ID"), clientSecret: required("GITHUB_APP_CLIENT_SECRET"), callbackUrl, appSlug, encryptionKey };
}

export function loadEnv(): Env {
	const jwtSecret = required("JWT_SECRET");
	if (jwtSecret.length < MIN_SECRET_LENGTH) {
		throw new Error(`JWT_SECRET 至少需要 ${String(MIN_SECRET_LENGTH)} 个字符，请用 openssl rand -base64 48 生成`);
	}
	return {
		port: integer("PORT", 3000),
		github: githubConfig(),
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
