import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIntelStore } from "../../src/main/code-intel-store";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-code-intel-"));
	dirs.push(dir);
	return dir;
}

describe("CodeIntelStore", () => {
	test("prediction settings persist independently and reject invalid model keys", () => {
		const dir = tmp();
		const store = new CodeIntelStore(dir);
		store.update({ prediction: { enabled: true, modelKey: "p/fast" } });
		store.update({ completion: { enabled: true } });
		expect(new CodeIntelStore(dir).status().prediction).toEqual({ enabled: true, modelKey: "p/fast" });
		store.update({ prediction: { enabled: false } });
		expect(store.status().prediction.modelKey).toBe("p/fast");
		expect(() => store.update({ prediction: { modelKey: "invalid" } })).toThrow();
	});
	test("starts with the index on, no search model, and completion off", () => {
		expect(new CodeIntelStore(tmp()).status()).toEqual({
			prediction: { enabled: false, modelKey: null },
			indexEnabled: true,
			searchModel: null,
			completion: { enabled: false, modelKey: null },
		});
	});

	test("keeps the chosen models across a restart", () => {
		const dir = tmp();
		const store = new CodeIntelStore(dir);
		store.update({ searchModel: "nekocode-abc/deepseek-chat", completion: { enabled: true, modelKey: "deepseek/deepseek-chat" } });
		expect(new CodeIntelStore(dir).status()).toEqual({
			prediction: { enabled: false, modelKey: null },
			indexEnabled: true,
			searchModel: "nekocode-abc/deepseek-chat",
			completion: { enabled: true, modelKey: "deepseek/deepseek-chat" },
		});
	});

	test("a partial update leaves the rest, and null clears a model", () => {
		const store = new CodeIntelStore(tmp());
		store.update({ searchModel: "p/search", completion: { modelKey: "p/chat" } });
		store.update({ completion: { enabled: true } });
		expect(store.status().completion).toEqual({ enabled: true, modelKey: "p/chat" });
		store.update({ searchModel: null });
		expect(store.status().searchModel).toBeNull();
	});

	test("refuses something that is not a model key", () => {
		const store = new CodeIntelStore(tmp());
		expect(() => store.update({ searchModel: "no-provider" })).toThrow(/model key/);
		expect(() => store.update({ completion: { modelKey: 42 as unknown as string } })).toThrow(/model key/);
	});
});
