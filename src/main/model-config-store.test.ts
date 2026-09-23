import { describe, expect, test } from "bun:test";
import type { StoredProfile } from "./model-config-store";
import { modelInputList, toSummary, validateProfileFile } from "./model-config-store";

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
