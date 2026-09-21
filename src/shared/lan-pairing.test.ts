import { expect, test } from "bun:test";
import { encodeLanPairing, parseLanPairing } from "./lan-pairing";

const now = 1_800_000_000_000;
const pairing = { code: "ABCD012345", expiresAt: now + 300_000 };

test("desktop QR payload automatically supplies the same endpoint and one-time code as manual pairing", () => {
	const text = encodeLanPairing("192.168.1.8", pairing);
	expect(parseLanPairing(text, now)).toEqual({ type: "nekocode.lan-pairing", version: 1, endpoint: "http://192.168.1.8:47832", ...pairing });
	expect(parseLanPairing(encodeLanPairing("http://10.0.0.5:49000", pairing), now).endpoint).toBe("http://10.0.0.5:49000");
});

test("expired, unrelated, malformed and future-version QR contents never configure a connection", () => {
	const valid = encodeLanPairing("192.168.1.8", pairing);
	expect(() => parseLanPairing(valid, pairing.expiresAt)).toThrow("已过期");
	for (const content of ["https://example.com", "null", "[]", "{", "x".repeat(2049),
		JSON.stringify({ ...JSON.parse(valid), version: 2 }),
		JSON.stringify({ ...JSON.parse(valid), code: "invalid" }),
		JSON.stringify({ ...JSON.parse(valid), expiresAt: "tomorrow" }),
		JSON.stringify({ ...JSON.parse(valid), type: "unrelated-app" }),
	]) expect(() => parseLanPairing(content, now)).toThrow();
});

test("scanned payload cannot redirect pairing to a public host, embed credentials, or inject a path", () => {
	const valid = JSON.parse(encodeLanPairing("192.168.1.8", pairing));
	for (const endpoint of ["http://example.com", "http://8.8.8.8", "http://user:secret@192.168.1.8", "http://192.168.1.8/run?command=hello", "file:///tmp/example"]) {
		expect(() => parseLanPairing(JSON.stringify({ ...valid, endpoint }), now)).toThrow();
	}
});
