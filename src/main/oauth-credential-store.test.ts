import { afterEach, expect, test } from "bun:test";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { OAuthCredentialStore } from "./oauth-credential-store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		const target = realpathSync(root);
		if (!target.startsWith(resolve(realpathSync(tmpdir())) + sep) || !basename(target).startsWith("nekocode-credential-test-")) throw new Error("Unsafe cleanup path");
		rmSync(target, { recursive: true, force: true });
	}
});

function fixture() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "nekocode-credential-test-")); roots.push(root);
	const key = randomBytes(32);
	const encryption = {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "gnome_libsecret" as const,
		encryptString(value: string) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
		},
		decryptString(value: Buffer) {
			const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
			cipher.setAuthTag(value.subarray(12, 28));
			return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
		},
	};
	return { root, encryption, store: new OAuthCredentialStore(root, encryption) };
}

test("OAuth credentials survive restart encrypted and logout removes them", () => {
	const { root, encryption, store } = fixture();
	const credential = { accessToken: "sensitive-access", refreshToken: "sensitive-refresh", expiresAt: Date.now() + 3600000 };
	store.write("antigravity", credential, { email: "user@example.com", projectId: "project", signedInAt: 1 });
	const disk = readFileSync(join(root, "oauth-credentials.json"), "utf8");
	expect(disk).not.toContain(credential.accessToken);
	expect(disk).not.toContain(credential.refreshToken);
	expect(JSON.stringify(store.account("antigravity"))).not.toContain("secret");
	const restarted = new OAuthCredentialStore(root, encryption);
	expect(restarted.read("antigravity")).toEqual(credential);
	restarted.delete("antigravity");
	expect(new OAuthCredentialStore(root, encryption).has("antigravity")).toBe(false);
});

test("unavailable encryption cannot fall back to plaintext", () => {
	const { root, encryption } = fixture();
	const store = new OAuthCredentialStore(root, { ...encryption, isEncryptionAvailable: () => false });
	expect(() => store.write("antigravity", { accessToken: "a", refreshToken: "r", expiresAt: 1 }, { signedInAt: 1 })).toThrow("密钥环");
	expect(store.has("antigravity")).toBe(false);
});
