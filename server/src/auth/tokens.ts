import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Database, SessionDoc } from "../db";

/**
 * Two tokens, on purpose.
 *
 * The access token is a short-lived JWT nobody has to look up, which is what
 * keeps every authenticated request off the database. The refresh token is a
 * long-lived opaque string that only exists as a row — so it can be revoked,
 * rotated, and listed as "signed-in devices". A single long-lived JWT would
 * have neither property.
 */

export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	/** Seconds until the access token expires, for the client's own timer. */
	expiresIn: number;
}

export interface AccessClaims {
	userId: string;
	email: string;
}

export interface VerifiedAccessClaims extends AccessClaims {
	expiresAt: number;
}

const ISSUER = "nekocode";
const AUDIENCE = "nekocode-app";

function key(secret: string): Uint8Array {
	return new TextEncoder().encode(secret);
}

async function signAccess(
	claims: AccessClaims,
	secret: string,
	ttlSeconds: number,
): Promise<string> {
	return new SignJWT({ email: claims.email })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(claims.userId)
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
		.sign(key(secret));
}

/** Null rather than throwing: an expired token is an ordinary 401, not a fault. */
export async function verifyAccess(token: string, secret: string): Promise<VerifiedAccessClaims | null> {
	try {
		const { payload } = await jwtVerify(token, key(secret), {
			issuer: ISSUER,
			audience: AUDIENCE,
			algorithms: ["HS256"],
		});
		if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
		if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
		return { userId: payload.sub, email: payload.email, expiresAt: payload.exp * 1000 };
	} catch {
		return null;
	}
}

/** Refresh tokens are looked up by hash, so the database never holds a usable one. */
function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export interface IssueOptions {
	db: Database;
	secret: string;
	accessTtlSeconds: number;
	refreshTtlSeconds: number;
	user: { id: string; email: string };
	userAgent?: string;
	ip?: string;
}

export async function issueTokens(options: IssueOptions): Promise<TokenPair> {
	const refreshToken = randomBytes(32).toString("base64url");
	const now = new Date();
	const session: SessionDoc = {
		_id: randomUUID(),
		userId: options.user.id,
		tokenHash: hashToken(refreshToken),
		expiresAt: new Date(now.getTime() + options.refreshTtlSeconds * 1000),
		createdAt: now,
		lastUsedAt: now,
		...(options.userAgent ? { userAgent: options.userAgent.slice(0, 200) } : {}),
		...(options.ip ? { ip: options.ip } : {}),
	};
	await options.db.sessions.insertOne(session);
	return {
		accessToken: await signAccess(
			{ userId: options.user.id, email: options.user.email },
			options.secret,
			options.accessTtlSeconds,
		),
		refreshToken,
		expiresIn: options.accessTtlSeconds,
	};
}

/**
 * Trade a refresh token for a new pair, and burn the old one.
 *
 * Rotation is what makes a stolen refresh token a bounded problem: the thief
 * and the owner cannot both keep using it, so whoever loses the race is logged
 * out and notices. Null means the token was unknown, expired, or already spent.
 */
export async function rotateTokens(
	options: Omit<IssueOptions, "user"> & { refreshToken: string },
): Promise<(TokenPair & { user: { id: string; email: string } }) | null> {
	const { db, refreshToken } = options;
	// Deleted rather than read-then-updated: the delete is the atomic claim, so
	// two requests racing with the same token cannot both be served.
	const session = await db.sessions.findOneAndDelete({ tokenHash: hashToken(refreshToken) });
	if (!session || session.expiresAt.getTime() <= Date.now()) return null;

	const user = await db.users.findOne({ _id: session.userId });
	if (!user || !user.emailVerifiedAt) return null;

	const pair = await issueTokens({ ...options, user: { id: user._id, email: user.email } });
	return { ...pair, user: { id: user._id, email: user.email } };
}

export async function revokeToken(db: Database, refreshToken: string): Promise<void> {
	await db.sessions.deleteOne({ tokenHash: hashToken(refreshToken) });
}

/** Sign out everywhere — what a password change has to do. */
export async function revokeAllForUser(db: Database, userId: string): Promise<void> {
	await db.sessions.deleteMany({ userId });
}
