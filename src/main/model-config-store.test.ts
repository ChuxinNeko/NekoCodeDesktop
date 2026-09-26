import { describe, expect, test } from "bun:test";
import type { StoredProfile } from "./model-config-store";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { isValidModelThinking, modelInputList, thinkingRegistration, toSummary, validateProfileFile } from "./model-config-store";

function stored(overrides: Partial<StoredProfile> = {}): StoredProfile {
	return {
		id: "p1",
		name: "Test",
		baseUrl: "https://api.example.com",
		route: "/v1/chat/completions",
		api: "openai-completions",
		encryptedApiKey: "abc",
		modelIds: ["m1"],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function file(profiles: StoredProfile[]) {
	return { version: 1, profiles } as unknown;
}

describe("imageInput profile flag", () => {
	test("a profile written before the flag validates and summarizes false", () => {
		const [profile] = validateProfileFile(file([stored()]));
		expect(profile.imageInput).toBeUndefined();
		expect(toSummary(profile).imageInput).toBe(false);
	});

	test("true validates and round-trips through the summary", () => {
		const [profile] = validateProfileFile(file([stored({ imageInput: true })]));
		expect(toSummary(profile).imageInput).toBe(true);
	});

	test("a non-boolean flag is rejected", () => {
		expect(() => validateProfileFile(file([stored({ imageInput: "yes" as never })]))).toThrow();
	});

	test("modelInputList declares image only when enabled", () => {
		expect(modelInputList(true)).toEqual(["text", "image"]);
		expect(modelInputList(false)).toEqual(["text"]);
	});
});

describe("per-model thinking levels", () => {
	test("a profile without them validates and summarizes none", () => {
		const [profile] = validateProfileFile(file([stored()]));
		expect(toSummary(profile).modelThinking).toEqual({});
	});

	test("ordered sets of known levels for listed models round-trip", () => {
		const [profile] = validateProfileFile(file([stored({ modelThinking: { m1: ["low", "high", "xhigh"] } })]));
		expect(toSummary(profile).modelThinking).toEqual({ m1: ["low", "high", "xhigh"] });
	});

	test("unknown, empty, repeated or out-of-order levels, or an unlisted model, are rejected", () => {
		for (const modelThinking of [
			{ m1: ["ultra"] },
			{ m1: [] },
			{ m1: ["low", "low"] },
			{ m1: ["high", "low"] },
			{ m2: ["low"] },
			{ m1: "high" },
		]) {
			expect(() => validateProfileFile(file([stored({ modelThinking: modelThinking as never })]))).toThrow();
		}
		expect(isValidModelThinking(undefined)).toBe(true);
	});
});

describe("thinking levels as pi registers them", () => {
	const offered = (levels: Parameters<typeof thinkingRegistration>[0], reasoning = false) =>
		getSupportedThinkingLevels({ ...thinkingRegistration(levels, reasoning) } as never);

	test("without levels of its own a model follows the profile's switch, as before", () => {
		expect(thinkingRegistration(undefined, true)).toEqual({ reasoning: true });
		expect(offered(undefined, true)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(offered(undefined, false)).toEqual(["off"]);
	});

	test("pi offers exactly the levels checked", () => {
		expect(offered(["off", "low", "medium", "high"])).toEqual(["off", "low", "medium", "high"]);
		// xhigh and max appear only when named.
		expect(offered(["off", "low", "high", "xhigh", "max"])).toEqual(["off", "low", "high", "xhigh", "max"]);
		// A model that always thinks: no off.
		expect(offered(["medium", "high"])).toEqual(["medium", "high"]);
		// Only off: not a reasoning model at all.
		expect(thinkingRegistration(["off"], true)).toEqual({ reasoning: false });
	});

	test("checked levels keep pi's own request values; xhigh and max are named", () => {
		expect(thinkingRegistration(["off", "low", "xhigh"], false)).toEqual({
			reasoning: true,
			thinkingLevelMap: { minimal: null, medium: null, high: null, xhigh: "xhigh", max: null },
		});
	});
});
