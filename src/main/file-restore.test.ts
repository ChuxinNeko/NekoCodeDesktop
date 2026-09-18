import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { packPreimage, type ReversalPlan, type ReversalStep } from "./file-journal";
import { applyReversal, MAX_DIFF_PREVIEW, previewReversal } from "./file-restore";

const temporaries: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(realpathSync(tmpdir()), "nekocode-restore-"));
	temporaries.push(dir);
	return dir;
}

function write(root: string, relativePath: string, contents: string): void {
	const target = join(root, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

function read(root: string, relativePath: string): string {
	return readFileSync(join(root, relativePath), "utf8");
}

/** A step that puts `path` back to `contents`. */
function restoreTo(path: string, contents: string): ReversalStep {
	const buffer = Buffer.from(contents, "utf8");
	return { path, before: packPreimage(buffer), beforeBytes: buffer.length };
}

/** A step that removes `path`, because the agent created it. */
function removeStep(path: string): ReversalStep {
	return { path, before: null, beforeBytes: 0 };
}

function plan(steps: ReversalStep[], extra: Partial<ReversalPlan> = {}): ReversalPlan {
	return { steps, unrestorable: [], opaqueRuns: 0, ...extra };
}

afterEach(() => {
	const tempRoot = resolve(realpathSync(tmpdir()));
	for (const dir of temporaries.splice(0)) {
		const target = resolve(dir);
		if (!target.startsWith(tempRoot + sep) || !basename(target).startsWith("nekocode-restore-")) {
			throw new Error(`Refusing unsafe test cleanup: ${target}`);
		}
		rmSync(target, { recursive: true, force: true });
	}
});

describe("applyReversal", () => {
	test("puts a changed file back and removes one the agent created", async () => {
		const cwd = scratch();
		write(cwd, "src/a.ts", "rewritten by the agent");
		write(cwd, "src/new.ts", "created by the agent");

		const outcome = await applyReversal(
			plan([restoreTo("src/a.ts", "original"), removeStep("src/new.ts")]),
			cwd,
		);

		expect(outcome.warnings).toEqual([]);
		expect(outcome.restored).toBe(1);
		expect(outcome.deleted).toBe(1);
		expect(read(cwd, "src/a.ts")).toBe("original");
		expect(existsSync(join(cwd, "src/new.ts"))).toBe(false);
	});

	test("brings back a file the agent deleted", async () => {
		const cwd = scratch();
		const outcome = await applyReversal(plan([restoreTo("gone.ts", "was here")]), cwd);

		expect(outcome.restored).toBe(1);
		expect(read(cwd, "gone.ts")).toBe("was here");
	});

	test("a file already at its checkpoint contents is left alone", async () => {
		const cwd = scratch();
		write(cwd, "a.ts", "unchanged");
		const outcome = await applyReversal(plan([restoreTo("a.ts", "unchanged")]), cwd);

		expect(outcome).toEqual({ restored: 0, deleted: 0, warnings: [] });
	});

	test("removing a file that is already gone is not an error", async () => {
		const cwd = scratch();
		const outcome = await applyReversal(plan([removeStep("never-existed.ts")]), cwd);
		expect(outcome).toEqual({ restored: 0, deleted: 0, warnings: [] });
	});

	test("a directory left empty by the restore goes too", async () => {
		const cwd = scratch();
		write(cwd, "generated/only-file.ts", "new");
		await applyReversal(plan([removeStep("generated/only-file.ts")]), cwd);

		expect(existsSync(join(cwd, "generated"))).toBe(false);
	});

	test("a directory with anything else left in it stays", async () => {
		const cwd = scratch();
		write(cwd, "src/new.ts", "new");
		write(cwd, "src/kept.ts", "kept");
		await applyReversal(plan([removeStep("src/new.ts")]), cwd);

		expect(read(cwd, "src/kept.ts")).toBe("kept");
	});

	test("a path that escapes the workspace is refused, not written", async () => {
		const cwd = scratch();
		const outside = join(dirname(cwd), "escaped.txt");

		const outcome = await applyReversal(plan([restoreTo("../escaped.txt", "pwned")]), cwd);

		expect(existsSync(outside)).toBe(false);
		expect(outcome.restored).toBe(0);
		expect(outcome.warnings.join(" ")).toContain("../escaped.txt");
	});

	test("only the files the plan names are touched", async () => {
		// The reason this design needs no ignore rules: a restore can only reach
		// what a tool call said it was changing.
		const cwd = scratch();
		write(cwd, "node_modules/pkg/index.js", "installed");
		write(cwd, "untracked.txt", "mine");
		write(cwd, "a.ts", "changed");

		await applyReversal(plan([restoreTo("a.ts", "original")]), cwd);

		expect(read(cwd, "node_modules/pkg/index.js")).toBe("installed");
		expect(read(cwd, "untracked.txt")).toBe("mine");
		expect(read(cwd, "a.ts")).toBe("original");
	});

	test("deletions run before writes, so a directory can become a file again", async () => {
		const cwd = scratch();
		mkdirSync(join(cwd, "thing"), { recursive: true });
		write(cwd, "thing/inside.ts", "in the way");

		const outcome = await applyReversal(
			plan([removeStep("thing/inside.ts"), restoreTo("thing", "I was a file")]),
			cwd,
		);

		expect(outcome.warnings).toEqual([]);
		expect(read(cwd, "thing")).toBe("I was a file");
	});

	test("files it could not record are reported rather than passed over", async () => {
		const cwd = scratch();
		const outcome = await applyReversal(
			plan([], { unrestorable: [{ path: "huge.bin", before: null, beforeBytes: 9e6, skipped: "too-large" }] }),
			cwd,
		);

		expect(outcome.warnings).toHaveLength(1);
		expect(outcome.warnings[0]).toContain("huge.bin");
	});

	test("shell commands in the range are called out", async () => {
		const cwd = scratch();
		const outcome = await applyReversal(plan([], { opaqueRuns: 3 }), cwd);

		expect(outcome.warnings).toHaveLength(1);
		expect(outcome.warnings[0]).toContain("3");
	});
});

describe("previewReversal", () => {
	test("reports what a restore would do, by action", async () => {
		const cwd = scratch();
		write(cwd, "edited.ts", "one\nchanged\nthree\nfour\n");
		write(cwd, "added.ts", "alpha\nbeta\n");
		write(cwd, "same.ts", "same");

		const diff = await previewReversal(
			plan([
				restoreTo("edited.ts", "one\ntwo\nthree\n"),
				removeStep("added.ts"),
				restoreTo("removed.ts", "gone soon\n"),
				restoreTo("same.ts", "same"),
			]),
			cwd,
		);

		expect(diff.total).toBe(3);
		expect(diff.counts).toEqual({ overwrite: 1, recreate: 1, delete: 1 });
		expect(diff.additions).toBe(4);
		expect(diff.deletions).toBe(2);
		expect(diff.changes.map((change) => `${change.action} ${change.path}`)).toEqual([
			"delete added.ts",
			"overwrite edited.ts",
			"recreate removed.ts",
		]);
	});

	test("an untouched tree has no changes", async () => {
		const cwd = scratch();
		write(cwd, "a.ts", "a");
		expect((await previewReversal(plan([restoreTo("a.ts", "a")]), cwd)).total).toBe(0);
	});

	test("line totals count every change, not only the previewed ones", async () => {
		const cwd = scratch();
		const steps = Array.from({ length: MAX_DIFF_PREVIEW + 5 }, (_, i) =>
			restoreTo(`missing/f${i}.ts`, "x\ny\n"),
		);

		const diff = await previewReversal(plan(steps), cwd);

		expect(diff.truncated).toBe(true);
		expect(diff.changes).toHaveLength(MAX_DIFF_PREVIEW);
		expect(diff.additions).toBe(0);
		expect(diff.deletions).toBe((MAX_DIFF_PREVIEW + 5) * 2);
	});

	test("carries the caveats through so the confirmation can show them", async () => {
		const cwd = scratch();
		const diff = await previewReversal(
			plan([], {
				opaqueRuns: 2,
				unrestorable: [{ path: "big.bin", before: null, beforeBytes: 9e6, skipped: "too-large" }],
			}),
			cwd,
		);

		expect(diff.shellRuns).toBe(2);
		expect(diff.unrestorable).toEqual(["big.bin"]);
	});
});
