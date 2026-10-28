import { describe, expect, test } from "bun:test";
import { LinuxProfileBridge, profileRequest, isProfileStorage } from "../../src/main/linux-profile-bridge";

function fixture(prepare?: () => Promise<{ storage: Record<string, string> }>) {
	let preparations = 0;
	let stored: Record<string, string> = {};
	const encrypted: string[] = [];
	const bridge = new LinuxProfileBridge({
		encryption: {
			isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
			encryptString: (value) => { encrypted.push(value); return Buffer.from(`original-key:${value}`); },
			decryptString: (value) => value.toString().replace(/^original-key:/, ""),
		},
		prepare: async () => { preparations++; return prepare ? await prepare() : { storage: { "nekocode:onboarded": "1", "nekocode:theme": "dark" } }; },
		saveStorage: async (value) => { stored = value; },
	});
	return { bridge, encrypted, preparations: () => preparations, stored: () => stored };
}

describe("shared Linux profile bridge", () => {
	test("uses the original keyring for existing and new credentials, including long UTF-8 strings", async () => {
		const f = fixture(); const path = await f.bridge.start();
		try {
			expect(await profileRequest(path, f.bridge.token, "status")).toEqual({ available: true, backend: "gnome_libsecret" });
			const plaintext = "测试密钥🙂".repeat(20_000);
			const cipher = await profileRequest(path, f.bridge.token, "encrypt", plaintext) as string;
			expect(f.encrypted).toEqual([plaintext]);
			expect(await profileRequest(path, f.bridge.token, "decrypt", cipher)).toBe(plaintext);
		} finally { f.bridge.close(); }
	});
	test("requires authentication and never echoes plaintext in errors", async () => {
		const f = fixture(); const path = await f.bridge.start();
		try {
			await expect(profileRequest(path, "wrong-token", "encrypt", "private-key")).rejects.toThrow("operation failed");
			expect(f.encrypted).toEqual([]);
			await expect(profileRequest(path, f.bridge.token, "arbitrary-operation", "private-key")).rejects.toThrow("operation failed");
		} finally { f.bridge.close(); }
	});
	test("hands off onboarding and appearance once, then saves root changes back to the user", async () => {
		const f = fixture(); const path = await f.bridge.start();
		try {
			await expect(profileRequest(path, f.bridge.token, "storage", { test: "too-early" })).rejects.toThrow();
			const [one, two] = await Promise.all([profileRequest(path, f.bridge.token, "prepare"), profileRequest(path, f.bridge.token, "prepare")]);
			expect(one).toEqual(two);
			expect(one).toMatchObject({ storage: { "nekocode:onboarded": "1", "nekocode:theme": "dark" } });
			expect(f.preparations()).toBe(1);
			await profileRequest(path, f.bridge.token, "storage", { "nekocode:theme": "light" });
			expect(f.stored()).toEqual({ "nekocode:theme": "light" });
		} finally { f.bridge.close(); }
	});
	test("a refused handoff can be retried without getting stuck in a rejected promise", async () => {
		let calls = 0;
		const f = fixture(async () => { if (++calls === 1) throw new Error("busy"); return { storage: {} }; });
		const path = await f.bridge.start();
		try {
			await expect(profileRequest(path, f.bridge.token, "prepare")).rejects.toThrow();
			expect(f.bridge.prepared).toBe(false);
			expect(await profileRequest(path, f.bridge.token, "prepare")).toEqual({ storage: {} });
			expect(f.bridge.prepared).toBe(true);
		} finally { f.bridge.close(); }
	});
	test("storage snapshots contain only string values", () => {
		expect(isProfileStorage({ "nekocode:test": "value" })).toBe(true);
		for (const value of [null, [], "text", { key: { token: "secret" } }, { key: 1 }]) expect(isProfileStorage(value)).toBe(false);
	});
});
