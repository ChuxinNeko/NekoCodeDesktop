import { randomUUID } from "node:crypto";
import { Elysia, t } from "elysia";
import type { Database, UserDoc, VerificationDoc } from "../db";
import type { Env } from "../env";
import { fail, isEmailShaped, normalizeEmail, STATUS, type ErrorCode } from "../errors";
import type { Mailer } from "../mail/mailer";
import { clientIp, RateLimiter } from "../rate-limit";
import {
	CODE_TTL_MS,
	MAX_ATTEMPTS,
	RESEND_COOLDOWN_MS,
	generateCode,
	hashCode,
	isWellFormed,
	matchesCode,
} from "./codes";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword, passwordProblem, verifyPassword } from "./passwords";
import { issueTokens, revokeAllForUser, revokeToken, rotateTokens, verifyAccess } from "./tokens";

/** Failed sign-ins before an account is held shut for a while. */
const MAX_FAILED_LOGINS = 10;
const LOCK_DURATION_MS = 15 * 60_000;

export interface AuthDeps {
	db: Database;
	env: Env;
	mailer: Mailer;
}

/**
 * Everything an account does.
 *
 * Two rules run through all of it. Nothing here reveals whether an address has
 * an account — registering, resending and logging in all answer the same way
 * for a known and an unknown address, and what differs is only which mail goes
 * out. And nothing trusts the client about who it is: the only identity is a
 * signed access token or a refresh token that matches a stored hash.
 */
export function authRoutes(deps: AuthDeps) {
	const { db, env, mailer } = deps;
	// Outer, per-IP guards. The limits that matter for abuse of a single account
	// live on the verification document, where every instance can see them.
	const perIp = new RateLimiter(30, 10 * 60_000);
	const perIpSensitive = new RateLimiter(10, 10 * 60_000);

	/** Issue a code for an address and mail it, unless one was just sent. */
	async function sendCode(email: string, purpose: VerificationDoc["purpose"]): Promise<void> {
		const existing = await db.verifications.findOne({ email });
		if (existing && Date.now() - existing.sentAt.getTime() < RESEND_COOLDOWN_MS) return;

		const code = generateCode();
		const now = new Date();
		// Upserted rather than replaced so the `_id` we chose survives a resend —
		// a replacement without one would have Mongo mint an ObjectId, which is
		// not the string this collection is typed for.
		await db.verifications.updateOne(
			{ email },
			{
				$set: {
					email,
					codeHash: hashCode(code, email, env.jwtSecret),
					purpose,
					expiresAt: new Date(now.getTime() + CODE_TTL_MS),
					// Reset: a new code gets its own budget of wrong guesses.
					attempts: 0,
					sentAt: now,
				},
				$setOnInsert: { _id: randomUUID(), createdAt: now },
			},
			{ upsert: true },
		);
		// Awaited: if the mail cannot go out the user must be told now, not left
		// staring at a code screen for a message that will never arrive.
		if (purpose === "reset") await mailer.sendPasswordResetCode(email, code, Math.round(CODE_TTL_MS / 60_000));
		else await mailer.sendVerificationCode(email, code, Math.round(CODE_TTL_MS / 60_000));
	}

	function reject(set: { status?: number | string }, code: ErrorCode, message: string) {
		set.status = STATUS[code];
		return fail(code, message);
	}

	return new Elysia({ prefix: "/auth" })
		.derive(({ request }) => {
			const headers = Object.fromEntries(request.headers) as Record<string, string | undefined>;
			return { ip: clientIp(headers), userAgent: headers["user-agent"] };
		})

		/**
		 * Claim an address.
		 *
		 * Says so plainly when the address already has a verified account, which
		 * is a product decision rather than the cautious default: it tells anyone
		 * who asks whether a given email is registered here. The trade is a
		 * register form that can say "去登录" instead of sending people to a code
		 * screen to wait for mail that will never come.
		 *
		 * An address with an *unverified* account is not treated as taken — nobody
		 * proved they own it, so registering again simply resends.
		 */
		.post(
			"/register",
			async ({ body, set, ip }) => {
				if (!perIpSensitive.take(`register:${ip}`)) {
					set.headers["retry-after"] = String(perIpSensitive.retryAfter(`register:${ip}`));
					return reject(set, "too_many_requests", "操作过于频繁，请稍后再试");
				}
				const email = normalizeEmail(body.email);
				if (!isEmailShaped(email)) return reject(set, "invalid_request", "请输入有效的邮箱地址");
				const problem = passwordProblem(body.password);
				if (problem) return reject(set, "invalid_request", problem);

				const existing = await db.users.findOne({ email });
				if (existing?.emailVerifiedAt) {
					return reject(set, "email_taken", "这个邮箱已经注册过了，请直接登录");
				}

				const now = new Date();
				const passwordHash = await hashPassword(body.password);
				if (existing) {
					// Re-registering an address that never verified replaces the
					// password: nobody proved they own it, so nobody is losing access.
					await db.users.updateOne(
						{ _id: existing._id },
						{ $set: { passwordHash, updatedAt: now, failedLogins: 0 }, $unset: { lockedUntil: "" } },
					);
				} else {
					const user: UserDoc = {
						_id: randomUUID(),
						email,
						passwordHash,
						emailVerifiedAt: null,
						createdAt: now,
						updatedAt: now,
						failedLogins: 0,
					};
					try {
						await db.users.insertOne(user);
					} catch (error) {
						// Two registrations for one address raced; the unique index caught
						// the loser, and the winner's record is the one to keep.
						if (!isDuplicateKey(error)) throw error;
					}
				}
				await sendCode(email, "register");
				return { ok: true as const, next: "verify" as const };
			},
			{
				body: t.Object({
					email: t.String({ maxLength: 254 }),
					password: t.String({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH }),
				}),
			},
		)

		/** Redeem a code. On success the account is usable and already signed in. */
		.post(
			"/verify",
			async ({ body, set, ip, userAgent }) => {
				if (!perIpSensitive.take(`verify:${ip}`)) {
					set.headers["retry-after"] = String(perIpSensitive.retryAfter(`verify:${ip}`));
					return reject(set, "too_many_requests", "尝试过于频繁，请稍后再试");
				}
				const email = normalizeEmail(body.email);
				if (!isWellFormed(body.code)) return reject(set, "invalid_code", "验证码格式不正确");

				const record = await db.verifications.findOne({ email });
				if (!record || (record.purpose !== "register" && record.purpose !== "login")) {
					return reject(set, "code_expired", "验证码已过期，请重新获取");
				}
				if (record.expiresAt.getTime() <= Date.now()) {
					await db.verifications.deleteOne({ _id: record._id });
					return reject(set, "code_expired", "验证码已过期，请重新获取");
				}
				if (record.attempts >= MAX_ATTEMPTS) {
					await db.verifications.deleteOne({ _id: record._id });
					return reject(set, "code_expired", "尝试次数过多，请重新获取验证码");
				}
				if (!matchesCode(body.code, email, env.jwtSecret, record.codeHash)) {
					// Counted before the answer goes out, so a client that hangs up
					// mid-response has still spent the attempt.
					await db.verifications.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
					const left = MAX_ATTEMPTS - record.attempts - 1;
					return reject(set, "invalid_code", `验证码不正确，还可以尝试 ${String(Math.max(0, left))} 次`);
				}

				const user = await db.users.findOne({ email });
				if (!user) return reject(set, "invalid_request", "账号不存在，请重新注册");

				// Spent on success too: a code that stays valid after it worked is a
				// second key to the same door.
				await db.verifications.deleteOne({ _id: record._id });
				await db.users.updateOne(
					{ _id: user._id },
					{
						$set: { emailVerifiedAt: user.emailVerifiedAt ?? new Date(), updatedAt: new Date(), failedLogins: 0 },
						$unset: { lockedUntil: "" },
					},
				);
				const tokens = await issueTokens({
					db,
					secret: env.jwtSecret,
					accessTtlSeconds: env.accessTokenTtlSeconds,
					refreshTtlSeconds: env.refreshTokenTtlSeconds,
					user: { id: user._id, email: user.email },
					...(userAgent ? { userAgent } : {}),
					ip,
				});
				return { ...tokens, user: { id: user._id, email: user.email } };
			},
			{ body: t.Object({ email: t.String({ maxLength: 254 }), code: t.String({ maxLength: 6 }) }) },
		)

		/** Another code for an address mid-verification. Generic either way. */
		.post(
			"/resend",
			async ({ body, set, ip }) => {
				if (!perIpSensitive.take(`resend:${ip}`)) {
					set.headers["retry-after"] = String(perIpSensitive.retryAfter(`resend:${ip}`));
					return reject(set, "too_many_requests", "请求过于频繁，请稍后再试");
				}
				const email = normalizeEmail(body.email);
				if (!isEmailShaped(email)) return reject(set, "invalid_request", "请输入有效的邮箱地址");
				const user = await db.users.findOne({ email });
				// Only for accounts that exist and have not verified. Anything else
				// silently does nothing and answers the same.
				if (user && !user.emailVerifiedAt) await sendCode(email, "register");
				return { ok: true as const };
			},
			{ body: t.Object({ email: t.String({ maxLength: 254 }) }) },
		)

		.post(
			"/forgot",
			async ({ body, set, ip }) => {
				if (!perIpSensitive.take(`forgot:${ip}`)) {
					set.headers["retry-after"] = String(perIpSensitive.retryAfter(`forgot:${ip}`));
					return reject(set, "too_many_requests", "请求过于频繁，请稍后再试");
				}
				const email = normalizeEmail(body.email);
				if (!isEmailShaped(email)) return reject(set, "invalid_request", "请输入有效的邮箱地址");
				const user = await db.users.findOne({ email });
				if (user?.emailVerifiedAt) await sendCode(email, "reset");
				return { ok: true as const };
			},
			{ body: t.Object({ email: t.String({ maxLength: 254 }) }) },
		)

		.post(
			"/reset",
			async ({ body, set, ip }) => {
				if (!perIpSensitive.take(`reset:${ip}`)) {
					set.headers["retry-after"] = String(perIpSensitive.retryAfter(`reset:${ip}`));
					return reject(set, "too_many_requests", "尝试过于频繁，请稍后再试");
				}
				const email = normalizeEmail(body.email);
				if (!isEmailShaped(email)) return reject(set, "invalid_request", "请输入有效的邮箱地址");
				const problem = passwordProblem(body.newPassword);
				if (problem) return reject(set, "invalid_request", problem);
				if (!isWellFormed(body.code)) return reject(set, "invalid_code", "验证码格式不正确");

				const record = await db.verifications.findOne({ email });
				if (!record || record.purpose !== "reset") {
					return reject(set, "code_expired", "验证码已过期，请重新获取");
				}
				if (record.expiresAt.getTime() <= Date.now()) {
					await db.verifications.deleteOne({ _id: record._id });
					return reject(set, "code_expired", "验证码已过期，请重新获取");
				}
				if (record.attempts >= MAX_ATTEMPTS) {
					await db.verifications.deleteOne({ _id: record._id });
					return reject(set, "code_expired", "尝试次数过多，请重新获取验证码");
				}
				if (!matchesCode(body.code, email, env.jwtSecret, record.codeHash)) {
					await db.verifications.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
					const left = MAX_ATTEMPTS - record.attempts - 1;
					return reject(set, "invalid_code", `验证码不正确，还可以尝试 ${String(Math.max(0, left))} 次`);
				}

				const user = await db.users.findOne({ email });
				if (!user?.emailVerifiedAt) return reject(set, "code_expired", "验证码已过期，请重新获取");

				const passwordHash = await hashPassword(body.newPassword);
				const claimed = await db.verifications.deleteOne({ _id: record._id, purpose: "reset" });
				if (claimed.deletedCount !== 1) return reject(set, "code_expired", "验证码已过期，请重新获取");

				await db.users.updateOne(
					{ _id: user._id },
					{
						$set: { passwordHash, updatedAt: new Date(), failedLogins: 0 },
						$unset: { lockedUntil: "" },
					},
				);
				await revokeAllForUser(db, user._id);
				return { ok: true as const };
			},
			{
				body: t.Object({
					email: t.String({ maxLength: 254 }),
					code: t.String({ maxLength: 6 }),
					newPassword: t.String({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH }),
				}),
			},
		)

		.post(
			"/login",
			async ({ body, set, ip, userAgent }) => {
				if (!perIpSensitive.take(`login:${ip}`)) {
					set.headers["retry-after"] = String(perIpSensitive.retryAfter(`login:${ip}`));
					return reject(set, "too_many_requests", "尝试过于频繁，请稍后再试");
				}
				const email = normalizeEmail(body.email);
				const user = await db.users.findOne({ email });

				if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
					const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
					return reject(set, "account_locked", `登录失败次数过多，请 ${String(minutes)} 分钟后再试`);
				}

				// Verified even when the account is missing, so a wrong address and a
				// wrong password take the same time to answer.
				const ok = user
					? await verifyPassword(body.password, user.passwordHash)
					: await verifyPassword(body.password, DUMMY_HASH);
				if (!user || !ok) {
					if (user) {
						const failed = user.failedLogins + 1;
						await db.users.updateOne(
							{ _id: user._id },
							failed >= MAX_FAILED_LOGINS
								? { $set: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) } }
								: { $set: { failedLogins: failed } },
						);
					}
					return reject(set, "invalid_credentials", "邮箱或密码不正确");
				}

				if (!user.emailVerifiedAt) {
					// Correct password, unverified address: send a code and point the
					// client at the verification screen rather than calling it a failure.
					await sendCode(email, "login");
					return reject(set, "email_unverified", "请先验证邮箱，验证码已发送");
				}

				await db.users.updateOne(
					{ _id: user._id },
					{ $set: { failedLogins: 0, updatedAt: new Date() }, $unset: { lockedUntil: "" } },
				);
				const tokens = await issueTokens({
					db,
					secret: env.jwtSecret,
					accessTtlSeconds: env.accessTokenTtlSeconds,
					refreshTtlSeconds: env.refreshTokenTtlSeconds,
					user: { id: user._id, email: user.email },
					...(userAgent ? { userAgent } : {}),
					ip,
				});
				return { ...tokens, user: { id: user._id, email: user.email } };
			},
			{
				body: t.Object({
					email: t.String({ maxLength: 254 }),
					password: t.String({ maxLength: 256 }),
				}),
			},
		)

		.post(
			"/refresh",
			async ({ body, set, ip, userAgent }) => {
				if (!perIp.take(`refresh:${ip}`)) {
					set.headers["retry-after"] = String(perIp.retryAfter(`refresh:${ip}`));
					return reject(set, "too_many_requests", "请求过于频繁，请稍后再试");
				}
				const rotated = await rotateTokens({
					db,
					secret: env.jwtSecret,
					accessTtlSeconds: env.accessTokenTtlSeconds,
					refreshTtlSeconds: env.refreshTokenTtlSeconds,
					refreshToken: body.refreshToken,
					...(userAgent ? { userAgent } : {}),
					ip,
				});
				if (!rotated) return reject(set, "unauthorized", "登录状态已失效，请重新登录");
				return rotated;
			},
			{ body: t.Object({ refreshToken: t.String({ maxLength: 512 }) }) },
		)

		.post(
			"/logout",
			async ({ body, set }) => {
				await revokeToken(db, body.refreshToken);
				set.status = 204;
				return null;
			},
			{ body: t.Object({ refreshToken: t.String({ maxLength: 512 }) }) },
		)

		/** Sign out everywhere. What a password change or a lost phone needs. */
		.post("/logout-all", async ({ headers, set }) => {
			const claims = await bearer(headers.authorization, env.jwtSecret);
			if (!claims) return reject(set, "unauthorized", "请先登录");
			await revokeAllForUser(db, claims.userId);
			set.status = 204;
			return null;
		})

		.get("/me", async ({ headers, set }) => {
			const claims = await bearer(headers.authorization, env.jwtSecret);
			if (!claims) return reject(set, "unauthorized", "请先登录");
			const user = await db.users.findOne({ _id: claims.userId });
			if (!user?.emailVerifiedAt) return reject(set, "unauthorized", "请先登录");
			return { id: user._id, email: user.email, createdAt: user.createdAt.toISOString() };
		});
}

/**
 * A hash to check a password against when the account does not exist.
 *
 * Keeps a failed sign-in the same speed whether or not the address is known.
 * Registration now discloses that anyway, so this is no longer the defence it
 * started as — but it still costs an attacker a full Argon2 per guess, which is
 * the point worth keeping.
 */
const DUMMY_HASH =
	"$argon2id$v=19$m=65536,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$3s5Nt1Yq1cZkQd0rF2xJ8Lh6mQvXo7Kx1pQ2rT4uV5w";

async function bearer(
	header: string | undefined,
	secret: string,
): Promise<{ userId: string; email: string } | null> {
	const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (!token) return null;
	return verifyAccess(token, secret);
}

function isDuplicateKey(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}
