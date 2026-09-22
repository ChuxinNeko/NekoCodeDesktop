import { describe, expect, test } from "bun:test";
import type { Database, SessionDoc, UserDoc, VerificationDoc } from "../db";
import type { Env } from "../env";
import type { Mailer } from "../mail/mailer";
import { hashCode } from "./codes";
import { hashPassword, verifyPassword } from "./passwords";
import { authRoutes } from "./routes";

const SECRET = "test-secret-that-is-long-enough-32";

const env = {
	jwtSecret: SECRET,
	accessTokenTtlSeconds: 900,
	refreshTokenTtlSeconds: 2_592_000,
} as Env;

type Doc = UserDoc | VerificationDoc | SessionDoc;

function matches<T extends Doc>(doc: T, filter: Record<string, unknown>): boolean {
	return Object.entries(filter).every(([key, value]) => doc[key as keyof T] === value);
}

function applyUpdate<T extends Doc>(doc: T, update: Record<string, unknown>): void {
	const set = update.$set as Record<string, unknown> | undefined;
	const inc = update.$inc as Record<string, number> | undefined;
	const unset = update.$unset as Record<string, unknown> | undefined;
	const target = doc as unknown as Record<string, unknown>;
	if (set) for (const [key, value] of Object.entries(set)) target[key] = value;
	if (inc) for (const [key, value] of Object.entries(inc)) target[key] = (target[key] as number) + value;
	if (unset) for (const key of Object.keys(unset)) delete target[key];
}

class FakeCollection<T extends Doc> {
	readonly docs: T[] = [];

	findOne(filter: Record<string, unknown>): Promise<T | null> {
		return Promise.resolve(this.docs.find((doc) => matches(doc, filter)) ?? null);
	}

	updateOne(
		filter: Record<string, unknown>,
		update: Record<string, unknown>,
		options?: { upsert?: boolean },
	): Promise<{ modifiedCount: number; upsertedCount: number }> {
		const doc = this.docs.find((candidate) => matches(candidate, filter));
		if (doc) {
			applyUpdate(doc, update);
			return Promise.resolve({ modifiedCount: 1, upsertedCount: 0 });
		}
		if (!options?.upsert) return Promise.resolve({ modifiedCount: 0, upsertedCount: 0 });
		const inserted = { ...(update.$setOnInsert as Record<string, unknown>), ...(update.$set as Record<string, unknown>) };
		this.docs.push(inserted as unknown as T);
		return Promise.resolve({ modifiedCount: 0, upsertedCount: 1 });
	}

	insertOne(doc: T): Promise<{ insertedId: string }> {
		this.docs.push(doc);
		return Promise.resolve({ insertedId: doc._id });
	}

	deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
		const index = this.docs.findIndex((doc) => matches(doc, filter));
		if (index < 0) return Promise.resolve({ deletedCount: 0 });
		this.docs.splice(index, 1);
		return Promise.resolve({ deletedCount: 1 });
	}

	deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
		const kept = this.docs.filter((doc) => !matches(doc, filter));
		const removed = this.docs.length - kept.length;
		this.docs.length = 0;
		this.docs.push(...kept);
		return Promise.resolve({ deletedCount: removed });
	}
}

interface Sent {
	to: string;
	code: string;
}

function fakeMailer() {
	const sent = { verification: [] as Sent[], reset: [] as Sent[] };
	const mailer: Mailer = {
		sendVerificationCode: (to, code) => {
			sent.verification.push({ to, code });
			return Promise.resolve();
		},
		sendPasswordResetCode: (to, code) => {
			sent.reset.push({ to, code });
			return Promise.resolve();
		},
		close: () => Promise.resolve(),
	};
	return { mailer, sent };
}

function fixture() {
	const users = new FakeCollection<UserDoc>();
	const verifications = new FakeCollection<VerificationDoc>();
	const sessions = new FakeCollection<SessionDoc>();
	const db = {
		users,
		verifications,
		sessions,
		close: () => Promise.resolve(),
	} as unknown as Database;
	const { mailer, sent } = fakeMailer();
	const app = authRoutes({ db, env, mailer });
	return { users, verifications, sessions, sent, post, resetDoc };
	async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
		const response = await app.handle(
			new Request(`http://localhost${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		return { status: response.status, json: await response.json() };
	}
	function resetDoc(email: string): VerificationDoc | undefined {
		return verifications.docs.find((doc) => doc.email === email && doc.purpose === "reset");
	}
}

async function addUser(
	users: FakeCollection<UserDoc>,
	email: string,
	password: string,
	verified: boolean,
): Promise<UserDoc> {
	const now = new Date();
	const user: UserDoc = {
		_id: `user-${email}`,
		email,
		passwordHash: await hashPassword(password),
		emailVerifiedAt: verified ? now : null,
		createdAt: now,
		updatedAt: now,
		failedLogins: 3,
		lockedUntil: new Date(Date.now() + 60_000),
	};
	users.docs.push(user);
	return user;
}

describe("POST /auth/forgot", () => {
	test("normalizes a verified address, stores a reset code and mails it", async () => {
		const f = fixture();
		await addUser(f.users, "neko@example.com", "old-password-1", true);

		const { status, json } = await f.post("/auth/forgot", { email: "  Neko@Example.COM " });
		expect(status).toBe(200);
		expect(json).toEqual({ ok: true });

		const doc = f.resetDoc("neko@example.com");
		expect(doc).toBeDefined();
		expect(f.sent.verification).toHaveLength(0);
		expect(f.sent.reset).toHaveLength(1);
		expect(f.sent.reset[0]?.to).toBe("neko@example.com");
		const code = f.sent.reset[0]?.code ?? "";
		expect(doc?.codeHash).toBe(hashCode(code, "neko@example.com", SECRET));
	});

	test("answers the same for unknown and unverified addresses, sending nothing", async () => {
		const f = fixture();
		await addUser(f.users, "pending@example.com", "old-password-1", false);

		for (const email of ["ghost@example.com", "pending@example.com"]) {
			const { status, json } = await f.post("/auth/forgot", { email });
			expect(status).toBe(200);
			expect(json).toEqual({ ok: true });
		}
		expect(f.sent.reset).toHaveLength(0);
		expect(f.sent.verification).toHaveLength(0);
		expect(f.verifications.docs).toHaveLength(0);
	});
});

describe("POST /auth/reset", () => {
	test("a wrong code spends an attempt and changes nothing", async () => {
		const f = fixture();
		const user = await addUser(f.users, "neko@example.com", "old-password-1", true);
		await f.post("/auth/forgot", { email: "neko@example.com" });
		const session: SessionDoc = {
			_id: "s1",
			userId: user._id,
			tokenHash: "hash",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
			lastUsedAt: new Date(),
		};
		f.sessions.docs.push(session);

		const { status, json } = await f.post("/auth/reset", {
			email: "neko@example.com",
			code: "000000",
			newPassword: "new-password-9",
		});
		expect(status).toBe(400);
		expect((json as { error: { code: string } }).error.code).toBe("invalid_code");

		const doc = f.resetDoc("neko@example.com");
		expect(doc?.attempts).toBe(1);
		expect(await verifyPassword("old-password-1", f.users.docs[0]?.passwordHash ?? "")).toBe(true);
		expect(f.sessions.docs).toHaveLength(1);
	});

	test("success resets the password, unlocks the account and revokes only its sessions", async () => {
		const f = fixture();
		const user = await addUser(f.users, "neko@example.com", "old-password-1", true);
		const other = await addUser(f.users, "other@example.com", "other-password-2", true);
		const stamp = new Date();
		f.sessions.docs.push(
			{ _id: "s1", userId: user._id, tokenHash: "a", expiresAt: stamp, createdAt: stamp, lastUsedAt: stamp },
			{ _id: "s2", userId: user._id, tokenHash: "b", expiresAt: stamp, createdAt: stamp, lastUsedAt: stamp },
			{ _id: "s3", userId: other._id, tokenHash: "c", expiresAt: stamp, createdAt: stamp, lastUsedAt: stamp },
		);

		await f.post("/auth/forgot", { email: "neko@example.com" });
		const code = f.sent.reset[0]?.code ?? "";

		const { status, json } = await f.post("/auth/reset", {
			email: "neko@example.com",
			code,
			newPassword: "new-password-9",
		});
		expect(status).toBe(200);
		expect(json).toEqual({ ok: true });

		const updated = f.users.docs.find((doc) => doc._id === user._id);
		expect(await verifyPassword("old-password-1", updated?.passwordHash ?? "")).toBe(false);
		expect(await verifyPassword("new-password-9", updated?.passwordHash ?? "")).toBe(true);
		expect(updated?.failedLogins).toBe(0);
		expect(updated?.lockedUntil).toBeUndefined();
		expect(f.resetDoc("neko@example.com")).toBeUndefined();
		expect(f.sessions.docs.map((doc) => doc._id)).toEqual(["s3"]);

		const again = await f.post("/auth/reset", {
			email: "neko@example.com",
			code,
			newPassword: "another-password-7",
		});
		expect(again.status).toBe(410);
		expect((again.json as { error: { code: string } }).error.code).toBe("code_expired");
	});
});

describe("purpose separation", () => {
	test("a reset code is code_expired to /verify and is not consumed", async () => {
		const f = fixture();
		await addUser(f.users, "neko@example.com", "old-password-1", true);
		await f.post("/auth/forgot", { email: "neko@example.com" });
		const code = f.sent.reset[0]?.code ?? "";

		const { status, json } = await f.post("/auth/verify", { email: "neko@example.com", code });
		expect(status).toBe(410);
		expect((json as { error: { code: string } }).error.code).toBe("code_expired");
		expect(f.resetDoc("neko@example.com")).toBeDefined();
	});

	test("a register code is code_expired to /reset and is not consumed", async () => {
		const f = fixture();
		await addUser(f.users, "neko@example.com", "old-password-1", false);
		const register = await f.post("/auth/register", { email: "neko@example.com", password: "old-password-1" });
		expect(register.status).toBe(200);
		const code = f.sent.verification[0]?.code ?? "";
		expect(f.verifications.docs[0]?.purpose).toBe("register");

		const { status, json } = await f.post("/auth/reset", {
			email: "neko@example.com",
			code,
			newPassword: "new-password-9",
		});
		expect(status).toBe(410);
		expect((json as { error: { code: string } }).error.code).toBe("code_expired");
		expect(f.verifications.docs[0]?.purpose).toBe("register");
	});
});
