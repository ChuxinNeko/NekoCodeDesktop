/**
 * One error shape for the whole API.
 *
 * A machine-readable `code` next to a human `message`, because the app has to
 * branch on some of these — an unverified email sends the user to the code
 * screen rather than showing them a red box — and a client that has to match on
 * prose breaks the first time the prose is improved.
 */
export interface ApiError {
	error: { code: ErrorCode; message: string };
}

export type ErrorCode =
	| "invalid_request"
	| "email_taken"
	| "invalid_credentials"
	| "email_unverified"
	| "invalid_code"
	| "code_expired"
	| "too_many_requests"
	| "unauthorized"
	| "account_locked"
	| "server_error";

export const STATUS: Record<ErrorCode, number> = {
	invalid_request: 400,
	email_taken: 409,
	invalid_credentials: 401,
	email_unverified: 403,
	invalid_code: 400,
	code_expired: 410,
	too_many_requests: 429,
	unauthorized: 401,
	account_locked: 423,
	server_error: 500,
};

export function fail(code: ErrorCode, message: string): ApiError {
	return { error: { code, message } };
}

/** Lower-cased and trimmed, which is the form everything else compares against. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * A deliberately loose check.
 *
 * Whether an address exists is settled by whether a code sent to it comes back,
 * not by a regex — so this only rejects what is obviously not an address, and
 * leaves the real verdict to the mail.
 */
export function isEmailShaped(email: string): boolean {
	return email.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}
