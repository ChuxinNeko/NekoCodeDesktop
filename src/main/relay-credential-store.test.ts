import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayCredentialStore, type RelayAccountSession } from "./relay-credential-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-relay-store-"));
	dirs.push(dir);
	return dir;
}

function fakeEncryption() {
	return {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "kwallet6" as const,
		encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
		decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
	};
}

const session: RelayAccountSession = {
	accessToken: "access-token-secret",
	refreshToken: "refresh-token-secret",
	expiresAt: Date.now() + 900_000,
	user: { id: "user-1", email: "neko@example.com" },
};

describe("RelayCredentialStore", () => {
	test("identity is stable across instances and never written in plaintext", async () => {
		const dir = tmp();
		const store = new RelayCredentialStore(dir, fakeEncryption());
		const identity = await store.identity();
		expect(identity.id).toMatch(/^[a-f0-9]{64}$/);
		const again = new RelayCredentialStore(dir, fakeEncryption());
		expect(await again.identity()).toEqual(identity);
		const raw = readFileSync(join(dir, "relay-credentials.json"), "utf8");
		expect(raw).not.toContain(identity.privateKey);
	});

	test("account round-trips, is encrypted on disk, and clearing keeps the identity", async () => {
		const dir = tmp();
		const store = new RelayCredentialStore(dir, fakeEncryption());
		const identity = await store.identity();
		store.writeAccount(session);
		expect(store.account()).toEqual(session);
		expect(new RelayCredentialStore(dir, fakeEncryption()).account()).toEqual(session);
		const raw = readFileSync(join(dir, "relay-credentials.json"), "utf8");
		expect(raw).not.toContain(session.accessToken);
		expect(raw).not.toContain(session.refreshToken);

		store.clearAccount();
		expect(store.account()).toBeNull();
		expect(await store.identity()).toEqual(identity);
	});

	test("a corrupt file regenerates the identity and reports no account", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "relay-credentials.json"), "{oops");
		const store = new RelayCredentialStore(dir, fakeEncryption());
		expect(store.account()).toBeNull();
		const identity = await store.identity();
		expect(identity.id).toMatch(/^[a-f0-9]{64}$/);
	});

	test("undecryptable secrets regenerate the identity and drop the account", async () => {
		const dir = tmp();
		const store = new RelayCredentialStore(dir, fakeEncryption());
		const original = await store.identity();
		store.writeAccount(session);
		const flaky = { ...fakeEncryption(), decryptString: () => { throw new Error("keyring locked"); } };
		const locked = new RelayCredentialStore(dir, flaky);
		expect(locked.account()).toBeNull();
		const regenerated = await locked.identity();
		expect(regenerated.id).not.toBe(original.id);
	});

	test("without a usable keyring nothing is generated or written", async () => {
		const dir = tmp();
		const insecure = { ...fakeEncryption(), isEncryptionAvailable: () => false };
		const store = new RelayCredentialStore(dir, insecure);
		await expect(store.identity()).rejects.toThrow("系统密钥环不可用，无法安全保存公网连接凭据");
		expect(() => store.writeAccount(session)).toThrow("系统密钥环不可用，无法安全保存公网连接凭据");
	});
});
