import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Six-digit email verification codes.
 *
 * Six digits is a million possibilities, which is not much — so the strength
 * here is not the code, it is the ceiling around it: a short expiry, a cap on
 * wrong guesses, and a cooldown on resends. Those three are what make guessing
 * cost more than it returns.
 */

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses before the code is spent and a new one has to be sent. */
export const MAX_ATTEMPTS = 5;
/** How long before a resend is allowed, so the endpoint cannot be a mail cannon. */
export const RESEND_COOLDOWN_MS = 60_000;

const CODE_PATTERN = /^\d{6}$/;

/**
 * A uniformly random code.
 *
 * `randomInt` rather than `Math.random` scaled: the latter is neither uniform
 * over this range nor unpredictable, and predictable is the whole problem.
 */
export function generateCode(): string {
	return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, "0");
}

export function isWellFormed(code: string): boolean {
	return CODE_PATTERN.test(code);
}

/**
 * What gets stored instead of the code.
 *
 * HMAC rather than a plain hash: a bare SHA-256 of six digits is a rainbow
 * table a laptop builds in under a second, so the server secret has to be part
 * of the input. The email is mixed in too, which stops a code captured for one
 * address from being replayed against another.
 */
export function hashCode(code: string, email: string, secret: string): string {
	return createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
}

/** Constant-time comparison, so a wrong code cannot be narrowed down by timing. */
export function matchesCode(
	code: string,
	email: string,
	secret: string,
	expectedHash: string,
): boolean {
	if (!isWellFormed(code)) return false;
	const actual = Buffer.from(hashCode(code, email, secret), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	// `timingSafeEqual` throws rather than returning false on a length mismatch,
	// which a malformed stored hash would otherwise turn into a 500.
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}
