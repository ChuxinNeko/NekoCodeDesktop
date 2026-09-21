import { expect, test } from "bun:test";
import { normalizeDesktopAddress } from "./lan-client";

test("pairing accepts LAN literals and never sends a device token to an arbitrary host", () => {
	expect(normalizeDesktopAddress("192.168.1.8")).toBe("http://192.168.1.8:47832");
	expect(normalizeDesktopAddress("http://10.0.0.2:49123")).toBe("http://10.0.0.2:49123");
	for (const address of ["https://example.com", "http://8.8.8.8", "http://user:password@192.168.1.8", "http://192.168.1.8/redirect", "http://192.168.1.8?token=secret", "http://192.168.1.8#secret"]) {
		expect(() => normalizeDesktopAddress(address)).toThrow();
	}
});
