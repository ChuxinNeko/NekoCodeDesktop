import { describe, expect, test } from "bun:test";
import { normalizeQqBotConfig, readPairingCode } from "./qqbot";

describe("readPairingCode", () => {
	test("accepts a bare code", () => {
		expect(readPairingCode("F5245DB77A")).toBe("F5245DB77A");
		expect(readPairingCode("  f5245db77a  ")).toBe("F5245DB77A");
	});

	test("accepts the command form in either language", () => {
		// `\b` after 配对 matched nothing — a word boundary is defined over
		// [A-Za-z0-9_], so every Chinese pairing attempt was silently dropped.
		expect(readPairingCode("/配对 F5245DB77A")).toBe("F5245DB77A");
		expect(readPairingCode("/pair F5245DB77A")).toBe("F5245DB77A");
		expect(readPairingCode("／配对 F5245DB77A")).toBe("F5245DB77A");
		expect(readPairingCode("/绑定F5245DB77A")).toBe("F5245DB77A");
		expect(readPairingCode("/PAIR f5245db77a")).toBe("F5245DB77A");
	});

	test("rejects anything that is not a code", () => {
		expect(readPairingCode("在吗")).toBeNull();
		expect(readPairingCode("/配对")).toBeNull();
		expect(readPairingCode("F5245DB77")).toBeNull();
		expect(readPairingCode("F5245DB77AB")).toBeNull();
		expect(readPairingCode("G5245DB77A")).toBeNull();
	});
});

describe("normalizeQqBotConfig", () => {
	test("reads a partial or mistyped file back through the defaults", () => {
		const config = normalizeQqBotConfig({ protocol: "nonsense", url: 42, appId: " 102 ", enabled: "yes" });

		expect(config.protocol).toBe("onebot");
		expect(config.url).toBe("ws://127.0.0.1:3001");
		expect(config.appId).toBe("102");
		expect(config.enabled).toBe(false);
	});

	test("drops the hand-typed allowlists an older file carried", () => {
		const config = normalizeQqBotConfig({ allowUsers: ["10001"], allowGroups: ["55555"] });

		expect(config).not.toHaveProperty("allowUsers");
		expect(config).not.toHaveProperty("allowGroups");
	});
});
