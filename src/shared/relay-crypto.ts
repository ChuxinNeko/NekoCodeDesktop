import {
	RELAY_MAX_PLAINTEXT_BYTES,
	RELAY_PROTOCOL_VERSION,
	type RelayCiphertext,
	type RelayDirection,
	type RelayIdentity,
} from "./relay";

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const AES_PARAMS: AesKeyGenParams = { name: "AES-GCM", length: 256 };
const GCM_TAG_BYTES = 16;
const IV_BYTES = 12;
const RAW_PUBLIC_KEY_BYTES = 65;
const MAX_KEY_STRING_LENGTH = 4096;
const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeB64Url(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 8192;
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		const slice = bytes.subarray(offset, offset + CHUNK);
		let part = "";
		for (const byte of slice) part += String.fromCharCode(byte);
		binary += part;
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeB64Url(value: string, maxBytes: number): Uint8Array | null {
	if (value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;
	if (!B64URL_PATTERN.test(value)) return null;
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return null;
	}
	if (binary.length > maxBytes) return null;
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function toHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

export function isRelayPublicKey(value: unknown): value is string {
	if (typeof value !== "string" || value.length > MAX_KEY_STRING_LENGTH) return false;
	const raw = decodeB64Url(value, RAW_PUBLIC_KEY_BYTES);
	return raw !== null && raw.length === RAW_PUBLIC_KEY_BYTES && raw[0] === 0x04;
}

export async function relayPublicId(publicKey: string): Promise<string> {
	if (!isRelayPublicKey(publicKey)) throw new Error("Invalid relay public key");
	const raw = decodeB64Url(publicKey, RAW_PUBLIC_KEY_BYTES)!;
	const digest = await globalThis.crypto.subtle.digest("SHA-256", raw as BufferSource);
	return toHex(new Uint8Array(digest));
}

export async function generateRelayIdentity(): Promise<RelayIdentity> {
	const pair = await globalThis.crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveKey", "deriveBits"]);
	const publicKey = encodeB64Url(new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey)));
	const privateKey = encodeB64Url(new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey)));
	return { version: RELAY_PROTOCOL_VERSION, id: await relayPublicId(publicKey), publicKey, privateKey };
}

export async function validateRelayIdentity(value: unknown): Promise<RelayIdentity | null> {
	try {
		if (!value || typeof value !== "object") return null;
		const candidate = value as RelayIdentity;
		if (candidate.version !== RELAY_PROTOCOL_VERSION) return null;
		if (typeof candidate.id !== "string" || !/^[a-f0-9]{64}$/.test(candidate.id)) return null;
		if (!isRelayPublicKey(candidate.publicKey)) return null;
		if (typeof candidate.privateKey !== "string" || candidate.privateKey.length > MAX_KEY_STRING_LENGTH) return null;
		if (!B64URL_PATTERN.test(candidate.privateKey)) return null;
		if ((await relayPublicId(candidate.publicKey)) !== candidate.id) return null;
		const subtle = globalThis.crypto.subtle;
		const privateRaw = decodeB64Url(candidate.privateKey, MAX_KEY_STRING_LENGTH)!;
		const privateKey = await subtle.importKey("pkcs8", privateRaw as BufferSource, ECDH_PARAMS, true, ["deriveKey", "deriveBits"]);
		const publicKey = await subtle.importKey(
			"raw",
			decodeB64Url(candidate.publicKey, RAW_PUBLIC_KEY_BYTES)! as BufferSource,
			ECDH_PARAMS,
			true,
			[],
		);
		const privateJwk = await subtle.exportKey("jwk", privateKey);
		const publicJwk = await subtle.exportKey("jwk", publicKey);
		const matching =
			privateJwk.kty === "EC" &&
			privateJwk.crv === "P-256" &&
			publicJwk.kty === "EC" &&
			publicJwk.crv === "P-256" &&
			typeof privateJwk.x === "string" &&
			typeof privateJwk.y === "string" &&
			privateJwk.x === publicJwk.x &&
			privateJwk.y === publicJwk.y;
		if (!matching) return null;
		return {
			version: RELAY_PROTOCOL_VERSION,
			id: candidate.id,
			publicKey: candidate.publicKey,
			privateKey: candidate.privateKey,
		};
	} catch {
		return null;
	}
}

export async function deriveRelayKey(identity: RelayIdentity, peerPublicKey: string): Promise<CryptoKey> {
	const subtle = globalThis.crypto.subtle;
	const peerRaw = decodeB64Url(peerPublicKey, RAW_PUBLIC_KEY_BYTES);
	const privateRaw = decodeB64Url(identity.privateKey, MAX_KEY_STRING_LENGTH);
	if (!peerRaw || peerRaw.length !== RAW_PUBLIC_KEY_BYTES || peerRaw[0] !== 0x04 || !privateRaw) {
		throw new Error("Invalid relay key material");
	}
	const publicKey = await subtle.importKey("raw", peerRaw as BufferSource, ECDH_PARAMS, false, []);
	const privateKey = await subtle.importKey("pkcs8", privateRaw as BufferSource, ECDH_PARAMS, false, ["deriveKey", "deriveBits"]);
	return subtle.deriveKey({ name: "ECDH", public: publicKey }, privateKey, AES_PARAMS, false, ["encrypt", "decrypt"]);
}

export function relayAad(
	connectionId: string,
	desktopId: string,
	peerId: string,
	direction: RelayDirection,
): Uint8Array {
	return encoder.encode(`nekocode-relay-v1\0${connectionId}\0${desktopId}\0${peerId}\0${direction}`);
}

export async function encryptRelayJson(key: CryptoKey, value: unknown, aad: Uint8Array): Promise<RelayCiphertext> {
	const plaintext = encoder.encode(JSON.stringify(value));
	if (plaintext.length > RELAY_MAX_PLAINTEXT_BYTES) throw new Error("中继消息过大");
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = await globalThis.crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
		key,
		plaintext as BufferSource,
	);
	return { version: RELAY_PROTOCOL_VERSION, iv: encodeB64Url(iv), data: encodeB64Url(new Uint8Array(sealed)) };
}

export function isRelayCiphertext(value: unknown): value is RelayCiphertext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as RelayCiphertext;
	if (candidate.version !== RELAY_PROTOCOL_VERSION) return false;
	const maxDataLength = Math.ceil((RELAY_MAX_PLAINTEXT_BYTES + GCM_TAG_BYTES) / 3) * 4;
	return (
		typeof candidate.iv === "string" &&
		candidate.iv.length > 0 &&
		candidate.iv.length <= 24 &&
		B64URL_PATTERN.test(candidate.iv) &&
		typeof candidate.data === "string" &&
		candidate.data.length > 0 &&
		candidate.data.length <= maxDataLength &&
		B64URL_PATTERN.test(candidate.data)
	);
}

export async function decryptRelayJson<T>(key: CryptoKey, value: RelayCiphertext, aad: Uint8Array): Promise<T> {
	if (!isRelayCiphertext(value)) throw new Error("Invalid relay ciphertext");
	const iv = decodeB64Url(value.iv, IV_BYTES);
	const data = decodeB64Url(value.data, RELAY_MAX_PLAINTEXT_BYTES + GCM_TAG_BYTES);
	if (!iv || iv.length !== IV_BYTES || !data) throw new Error("Invalid relay ciphertext");
	const plaintext = await globalThis.crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
		key,
		data as BufferSource,
	);
	const bytes = new Uint8Array(plaintext);
	if (bytes.length > RELAY_MAX_PLAINTEXT_BYTES) throw new Error("中继消息过大");
	return JSON.parse(decoder.decode(bytes)) as T;
}
