import { describe, expect, test } from "bun:test";
import {
	toSummary,
	validateProfileFile,
	type StoredProfile,
} from "./model-config-store";
import { decideModelAfterReload } from "./model-refresh";

const validProfile: StoredProfile = {
	id: "p1",
	name: "Test",
	baseUrl: "https://api.openai.com",
	route: "/v1/chat/completions",
	api: "openai-completions",
	encryptedApiKey: "aGk=",
	modelIds: ["gpt-4o"],
	createdAt: 1,
	updatedAt: 2,
};

describe("validateProfileFile", () => {
	test("accepts a valid file", () => {
		expect(
			validateProfileFile({ version: 1, profiles: [validProfile] }),
		).toHaveLength(1);
	});

	test("rejects bad version", () => {
		expect(() =>
			validateProfileFile({ version: 2, profiles: [validProfile] }),
		).toThrow("unexpected shape");
		expect(() =>
			validateProfileFile({ profiles: [validProfile] }),
		).toThrow("unexpected shape");
	});

	test("rejects missing secret field, bad api, non-string modelIds", () => {
		const noKey = { ...validProfile, encryptedApiKey: "" };
		expect(() =>
			validateProfileFile({ version: 1, profiles: [noKey] }),
		).toThrow("unexpected shape");
		const badApi = { ...validProfile, api: "grpc" };
		expect(() =>
			validateProfileFile({ version: 1, profiles: [badApi] }),
		).toThrow("unexpected shape");
		const badModels = { ...validProfile, modelIds: [1] };
		expect(() =>
			validateProfileFile({ version: 1, profiles: [badModels] }),
		).toThrow("unexpected shape");
		const badEndpoint = { ...validProfile, route: "/v1/messages" };
		expect(() =>
			validateProfileFile({ version: 1, profiles: [badEndpoint] }),
		).toThrow("unexpected shape");
	});

	test("rejects load-limit violations", () => {
		const tooMany = {
			version: 1,
			profiles: Array.from({ length: 101 }, (_, i) => ({
				...validProfile,
				id: `p${i}`,
			})),
		};
		expect(() => validateProfileFile(tooMany)).toThrow("unexpected shape");

		expect(() =>
			validateProfileFile({
				version: 1,
				profiles: [{ ...validProfile, modelIds: [] }],
			}),
		).toThrow("unexpected shape");

		expect(() =>
			validateProfileFile({
				version: 1,
				profiles: [{ ...validProfile, modelIds: ["x".repeat(201)] }],
			}),
		).toThrow("unexpected shape");

		expect(() =>
			validateProfileFile({
				version: 1,
				profiles: [validProfile, { ...validProfile }],
			}),
		).toThrow("unexpected shape");

		expect(() =>
			validateProfileFile({
				version: 1,
				profiles: [
					{ ...validProfile, name: "n".repeat(121) },
				],
			}),
		).toThrow("unexpected shape");

		expect(() =>
			validateProfileFile({
				version: 1,
				profiles: [
					{
						...validProfile,
						encryptedApiKey: "k".repeat(64 * 1024 + 1),
					},
				],
			}),
		).toThrow("unexpected shape");
	});

	test("summary never carries the encrypted key", () => {
		const summary = toSummary(validProfile);
		expect("encryptedApiKey" in summary).toBe(false);
		expect(summary.hasApiKey).toBe(true);
		expect("apiKey" in summary).toBe(false);
	});
});

describe("decideModelAfterReload", () => {
	const custom = { provider: "nekocode-p1", id: "gpt-4o" };
	const other = { provider: "nekocode-p2", id: "m2" };

	test("refreshes an existing custom model", () => {
		expect(
			decideModelAfterReload({
				current: custom,
				isRegistered: () => true,
				firstCustom: custom,
			}),
		).toEqual({ kind: "set", model: custom });
	});

	test("falls back to first custom when removed", () => {
		expect(
			decideModelAfterReload({
				current: custom,
				isRegistered: () => false,
				firstCustom: other,
			}),
		).toEqual({ kind: "set", model: other });
	});

	test("reports removed when no custom remains", () => {
		expect(
			decideModelAfterReload({
				current: custom,
				isRegistered: () => false,
				firstCustom: null,
			}),
		).toEqual({ kind: "removed" });
	});

	test("auto-selects first custom when no model configured", () => {
		expect(
			decideModelAfterReload({
				current: { provider: "unknown", id: "unknown" },
				isRegistered: () => true,
				firstCustom: custom,
			}),
		).toEqual({ kind: "set", model: custom });
		expect(
			decideModelAfterReload({
				current: null,
				isRegistered: () => true,
				firstCustom: custom,
			}),
		).toEqual({ kind: "set", model: custom });
	});

	test("leaves built-in models alone", () => {
		expect(
			decideModelAfterReload({
				current: { provider: "anthropic", id: "claude" },
				isRegistered: () => true,
				firstCustom: custom,
			}),
		).toEqual({ kind: "none" });
	});
});
