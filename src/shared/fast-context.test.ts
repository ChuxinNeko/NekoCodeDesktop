import { describe, expect, test } from "bun:test";
import { DEFAULT_FAST_CONTEXT_CONFIG, isFastContextConfig } from "./fast-context";

describe("isFastContextConfig", () => {
	test("accepts the default and a dedicated model", () => {
		expect(isFastContextConfig(DEFAULT_FAST_CONTEXT_CONFIG)).toBe(true);
		expect(isFastContextConfig({ modelKey: "zai/glm-4.6", thinkingLevel: "high" })).toBe(true);
		expect(isFastContextConfig({ modelKey: null, thinkingLevel: "off" })).toBe(true);
	});
	test("rejects malformed values", () => {
		expect(isFastContextConfig(null)).toBe(false);
		expect(isFastContextConfig(undefined)).toBe(false);
		expect(isFastContextConfig("low")).toBe(false);
		expect(isFastContextConfig({ modelKey: undefined, thinkingLevel: "low" })).toBe(false);
		expect(isFastContextConfig({ modelKey: "", thinkingLevel: "low" })).toBe(false);
		expect(isFastContextConfig({ modelKey: 3, thinkingLevel: "low" })).toBe(false);
		expect(isFastContextConfig({ modelKey: null, thinkingLevel: "extreme" })).toBe(false);
		expect(isFastContextConfig({ modelKey: null })).toBe(false);
	});
});
