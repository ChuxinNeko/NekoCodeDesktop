import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { statPaths as measure } from "./file-tools";
import { workflowSandbox } from "./workflow-test-utils";

describe("stat tool", () => {
	test("reports lines and bytes without the caller having to read the file", async () => {
		const sandbox = workflowSandbox();
		try {
			writeFileSync(join(sandbox.cwd, "three.txt"), "a\nb\nc\n");
			// No trailing newline: the last line still counts, or every file written
			// by an editor that omits one would come back one short.
			writeFileSync(join(sandbox.cwd, "ragged.txt"), "a\nb");
			writeFileSync(join(sandbox.cwd, "empty.txt"), "");

			const [three, ragged, empty] = await measure(sandbox.cwd, [
				"three.txt",
				"ragged.txt",
				"empty.txt",
			]);
			expect(three).toEqual({ path: "three.txt", kind: "file", bytes: 6, lines: 3, binary: false });
			expect(ragged.lines).toBe(2);
			expect(empty).toEqual({ path: "empty.txt", kind: "file", bytes: 0, lines: 0, binary: false });
		} finally {
			sandbox.cleanup();
		}
	});

	test("measures a whole batch in one call, which is the point of it", async () => {
		const sandbox = workflowSandbox();
		try {
			const names = Array.from({ length: 20 }, (_, i) => `file-${i}.txt`);
			for (const [i, name] of names.entries())
				writeFileSync(join(sandbox.cwd, name), "x\n".repeat(i + 1));

			const entries = await measure(sandbox.cwd, names);
			expect(entries).toHaveLength(20);
			expect(entries.map((entry) => entry.lines)).toEqual(names.map((_, i) => i + 1));
		} finally {
			sandbox.cleanup();
		}
	});

	test("binary content is reported as such rather than counted", async () => {
		const sandbox = workflowSandbox();
		try {
			writeFileSync(join(sandbox.cwd, "blob.bin"), Buffer.from([1, 2, 0, 3, 10, 10]));
			const [blob] = await measure(sandbox.cwd, ["blob.bin"]);
			expect(blob.binary).toBe(true);
			expect(blob.lines).toBeUndefined();
			expect(blob.bytes).toBe(6);
		} finally {
			sandbox.cleanup();
		}
	});

	test("directories and missing paths are named, not silently dropped", async () => {
		const sandbox = workflowSandbox();
		try {
			mkdirSync(join(sandbox.cwd, "src"));
			const [dir, missing] = await measure(sandbox.cwd, ["src", "nope.txt"]);
			expect(dir).toEqual({ path: "src", kind: "dir" });
			expect(missing.error).toBeTruthy();
			// One bad path must not cost the caller the rest of the batch.
			expect(missing.lines).toBeUndefined();
		} finally {
			sandbox.cleanup();
		}
	});

	test("refuses to measure outside the workspace", async () => {
		const sandbox = workflowSandbox();
		try {
			writeFileSync(join(sandbox.root, "secret.txt"), "x\n");
			const [escaped] = await measure(sandbox.cwd, ["../secret.txt"]);
			expect(escaped.error).toContain("outside the workspace");
			expect(escaped.bytes).toBeUndefined();
		} finally {
			sandbox.cleanup();
		}
	});
});
