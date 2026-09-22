import { MongoClient, type Collection, type Db } from "mongodb";

/**
 * A NekoCode account.
 *
 * `emailVerifiedAt` is the gate: an account exists from the moment someone
 * claims an address, but it cannot sign in until a code proves they read mail
 * sent to it. Keeping the unverified record rather than deferring the insert is
 * what lets a second registration attempt resend rather than duplicate.
 */
export interface UserDoc {
	_id: string;
	/** Lower-cased and trimmed. The unique key for an account. */
	email: string;
	passwordHash: string;
	emailVerifiedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	/** Set while an account is locked out after repeated failed sign-ins. */
	lockedUntil?: Date;
	failedLogins: number;
}

/**
 * An outstanding email verification.
 *
 * The code is never stored: what is kept is an HMAC of it under the server
 * secret, so a stolen database does not hand over live codes — six digits would
 * otherwise fall to an offline sweep of a million guesses instantly.
 *
 * One document per email, replaced on resend, removed by Mongo's TTL monitor.
 */
export interface VerificationDoc {
	_id: string;
	email: string;
	codeHash: string;
	purpose: "register" | "login" | "reset";
	expiresAt: Date;
	/** Wrong guesses so far. Past the cap the document is spent. */
	attempts: number;
	/** Rate-limits resends without needing a second collection. */
	sentAt: Date;
	createdAt: Date;
}

/**
 * A refresh token that has been handed out.
 *
 * Stored as a hash, rotated on every use, and revocable — which is what makes
 * "sign out this device" mean something. Access tokens stay stateless and
 * short-lived; these are the long-lived half and therefore the auditable one.
 */
export interface SessionDoc {
	_id: string;
	userId: string;
	tokenHash: string;
	expiresAt: Date;
	createdAt: Date;
	lastUsedAt: Date;
	/** What redeemed it last, for the account's device list. */
	userAgent?: string;
	ip?: string;
}

export interface RelayDeviceDoc {
	_id: string;
	userId: string;
	name: string;
	publicKey: string;
	createdAt: Date;
	lastSeenAt: Date;
}

export interface Database {
	users: Collection<UserDoc>;
	verifications: Collection<VerificationDoc>;
	sessions: Collection<SessionDoc>;
	devices: Collection<RelayDeviceDoc>;
	close(): Promise<void>;
}

/**
 * Connect and make sure the indexes exist.
 *
 * Created here rather than by hand because two of them are correctness, not
 * performance: the unique index on `email` is what stops two registrations
 * racing into two accounts for one address, and the TTL indexes are what
 * actually expire codes and sessions rather than merely marking them stale.
 */
export async function connect(uri: string, dbName: string): Promise<Database> {
	const client = new MongoClient(uri, { retryWrites: true });
	await client.connect();
	const db: Db = client.db(dbName);

	const users = db.collection<UserDoc>("users");
	const verifications = db.collection<VerificationDoc>("verifications");
	const sessions = db.collection<SessionDoc>("sessions");
	const devices = db.collection<RelayDeviceDoc>("devices");

	await Promise.all([
		users.createIndex({ email: 1 }, { unique: true, name: "email_unique" }),
		verifications.createIndex({ email: 1 }, { unique: true, name: "email_unique" }),
		// Mongo removes these on its own, so nothing has to sweep them.
		verifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl" }),
		sessions.createIndex({ tokenHash: 1 }, { unique: true, name: "token_unique" }),
		sessions.createIndex({ userId: 1 }, { name: "by_user" }),
		sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl" }),
		devices.createIndex({ userId: 1, lastSeenAt: -1 }, { name: "by_user" }),
	]);

	return {
		users,
		verifications,
		sessions,
		devices,
		close: () => client.close(),
	};
}
