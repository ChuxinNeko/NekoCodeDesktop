import { describe, expect, test } from "bun:test";
import { modelLabel } from "./agent";

describe("modelLabel", () => {
	test("a configured model reads as provider/model, not as its raw id", () => {
		expect(
			modelLabel({
				provider: "nekocode-3f2a7c18-0b44-4d0e-9f1a-77c1d6f0a9e2",
				providerName: "zai",
				id: "zai-org/glm-4.6",
				name: "zai-org/glm-4.6",
			}),
		).toBe("zai/glm-4.6");
	});

	test("a built-in model keeps the written-out name it already has", () => {
		expect(
			modelLabel({
				provider: "anthropic",
				providerName: "Anthropic",
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
			}),
		).toBe("Anthropic/Claude Sonnet 4.5");
	});

	test("an id with no vendor prefix survives whole", () => {
		expect(
			modelLabel({ provider: "p1", providerName: "local", id: "gpt-4o-mini", name: "gpt-4o-mini" }),
		).toBe("local/gpt-4o-mini");
	});

	test("an unnamed provider falls back to the id it is registered under", () => {
		expect(
			modelLabel({ provider: "nekocode-1", providerName: "  ", id: "a/b", name: "a/b" }),
		).toBe("nekocode-1/b");
	});
});
