import { describe, expect, test } from "bun:test";
import { RELAY_MAX_PLAINTEXT_BYTES } from "./relay";
import {
	decryptRelayJson,
	deriveRelayKey,
	encryptRelayJson,
	generateRelayIdentity,
	isRelayCiphertext,
	isRelayPublicKey,
	relayAad,
	relayPublicId,
	validateRelayIdentity,
} from "./relay-crypto";

const CONNECTION = "conn-123";
const DESKTOP = "desktop-abc";
const PEER = "peer-xyz";

describe("relay identity", () => {
	test("id is the public key fingerprint and the identity validates", async () => {
		const identity = await generateRelayIdentity();
		expect(identity.id).toMatch(/^[a-f0-9]{64}$/);
		expect(identity.id).toBe(await relayPublicId(identity.publicKey));
		expect(isRelayPublicKey(identity.publicKey)).toBe(true);
		expect(await validateRelayIdentity(identity)).toEqual(identity);
	});

	test("tampered id or private key fails validation", async () => {
		const identity = await generateRelayIdentity();
		const other = await generateRelayIdentity();
		expect(await validateRelayIdentity({ ...identity, id: "0".repeat(64) })).toBeNull();
		expect(await validateRelayIdentity({ ...identity, privateKey: other.privateKey })).toBeNull();
		expect(await validateRelayIdentity({ ...identity, privateKey: identity.publicKey })).toBeNull();
		expect(await validateRelayIdentity({ ...identity, privateKey: "not-base64url!!" })).toBeNull();
		expect(await validateRelayIdentity({ ...identity, version: 2 })).toBeNull();
		expect(await validateRelayIdentity(null)).toBeNull();
	});

	test("relayPublicId rejects malformed keys instead of hashing them", async () => {
		await expect(relayPublicId("AAAA")).rejects.toThrow("Invalid relay public key");
		await expect(relayPublicId("not-a-key!!")).rejects.toThrow("Invalid relay public key");
	});
});

describe("relay encryption", () => {
	test("mobile and desktop derive the same key and exchange JSON both ways", async () => {
		const desktop = await generateRelayIdentity();
		const mobile = await generateRelayIdentity();
		const mobileKey = await deriveRelayKey(mobile, desktop.publicKey);
		const desktopKey = await deriveRelayKey(desktop, mobile.publicKey);

		const request = { id: "req-1", method: "POST", path: "/api/tasks", body: { text: "帮我修这个 bug" } };
		const sealed = await encryptRelayJson(mobileKey, request, relayAad(CONNECTION, DESKTOP, PEER, "mobile-to-desktop"));
		expect(isRelayCiphertext(sealed)).toBe(true);
		expect(await decryptRelayJson<typeof request>(desktopKey, sealed, relayAad(CONNECTION, DESKTOP, PEER, "mobile-to-desktop"))).toEqual(request);

		const reply = { id: "req-1", status: 200, body: { tasks: [{ title: "中文标题" }] } };
		const sealedReply = await encryptRelayJson(desktopKey, reply, relayAad(CONNECTION, DESKTOP, PEER, "desktop-to-mobile"));
		expect(await decryptRelayJson<typeof reply>(mobileKey, sealedReply, relayAad(CONNECTION, DESKTOP, PEER, "desktop-to-mobile"))).toEqual(reply);
	});

	test("wrong direction, ids, or key all fail to decrypt", async () => {
		const desktop = await generateRelayIdentity();
		const mobile = await generateRelayIdentity();
		const mobileKey = await deriveRelayKey(mobile, desktop.publicKey);
		const desktopKey = await deriveRelayKey(desktop, mobile.publicKey);
		const sealed = await encryptRelayJson(mobileKey, { ok: true }, relayAad(CONNECTION, DESKTOP, PEER, "mobile-to-desktop"));

		await expect(decryptRelayJson(desktopKey, sealed, relayAad(CONNECTION, DESKTOP, PEER, "desktop-to-mobile"))).rejects.toThrow();
		await expect(decryptRelayJson(desktopKey, sealed, relayAad("other-conn", DESKTOP, PEER, "mobile-to-desktop"))).rejects.toThrow();
		await expect(decryptRelayJson(desktopKey, sealed, relayAad(CONNECTION, "other-desktop", PEER, "mobile-to-desktop"))).rejects.toThrow();
		await expect(decryptRelayJson(desktopKey, sealed, relayAad(CONNECTION, DESKTOP, "other-peer", "mobile-to-desktop"))).rejects.toThrow();

		const stranger = await generateRelayIdentity();
		const strangerKey = await deriveRelayKey(stranger, mobile.publicKey);
		await expect(decryptRelayJson(strangerKey, sealed, relayAad(CONNECTION, DESKTOP, PEER, "mobile-to-desktop"))).rejects.toThrow();
	});

	test("flipping any ciphertext byte breaks authentication", async () => {
		const desktop = await generateRelayIdentity();
		const mobile = await generateRelayIdentity();
		const mobileKey = await deriveRelayKey(mobile, desktop.publicKey);
		const desktopKey = await deriveRelayKey(desktop, mobile.publicKey);
		const aad = relayAad(CONNECTION, DESKTOP, PEER, "mobile-to-desktop");
		const sealed = await encryptRelayJson(mobileKey, { secret: "value" }, aad);

		for (const index of [0, Math.floor(sealed.data.length / 2), sealed.data.length - 3]) {
			const flipped = sealed.data[index] === "A" ? "B" : "A";
			const tampered = { ...sealed, data: sealed.data.slice(0, index) + flipped + sealed.data.slice(index + 1) };
			await expect(decryptRelayJson(desktopKey, tampered, aad)).rejects.toThrow();
		}
	});

	test("plaintext over the limit is rejected", async () => {
		const desktop = await generateRelayIdentity();
		const mobile = await generateRelayIdentity();
		const key = await deriveRelayKey(mobile, desktop.publicKey);
		const aad = relayAad(CONNECTION, DESKTOP, PEER, "mobile-to-desktop");
		await expect(encryptRelayJson(key, { blob: "x".repeat(RELAY_MAX_PLAINTEXT_BYTES) }, aad)).rejects.toThrow("中继消息过大");
	});

	test("malformed public keys and ciphertexts are rejected", async () => {
		expect(isRelayPublicKey("AAAA")).toBe(false);
		expect(isRelayPublicKey("!!!")).toBe(false);
		expect(isRelayPublicKey(65)).toBe(false);
		expect(isRelayCiphertext({ version: 1, iv: "", data: "abc" })).toBe(false);
		expect(isRelayCiphertext({ version: 2, iv: "abc", data: "abc" })).toBe(false);
		expect(isRelayCiphertext({ version: 1, iv: "ab+c", data: "abc" })).toBe(false);
		expect(isRelayCiphertext("sealed")).toBe(false);

		const desktop = await generateRelayIdentity();
		const mobile = await generateRelayIdentity();
		const key = await deriveRelayKey(mobile, desktop.publicKey);
		const aad = relayAad(CONNECTION, DESKTOP, PEER, "mobile-to-desktop");
		const sealed = await encryptRelayJson(key, { ok: true }, aad);
		await expect(decryptRelayJson(key, { ...sealed, iv: "AAAA" }, aad)).rejects.toThrow();
		await expect(decryptRelayJson(key, { ...sealed, data: "AAAA" }, aad)).rejects.toThrow();
	});
});
