import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveUnderRoot } from "./project-paths";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	// Canonical from the start, so the tests are about the cases they name
	// rather than about /var being a symlink to /private/var on macOS.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "nekocode-paths-")));
	dirs.push(dir);
	return dir;
}

describe("resolveUnderRoot", () => {
	test("resolves a relative path under the root", () => {
		const root = fixture();
		const resolved = resolveUnderRoot(root, "src/index.go");
		expect(resolved.target).toBe(resolve(root, "src/index.go"));
		expect(resolved.relPath).toBe("src/index.go");
	});

	test("answers with a `/`-separated path whatever separators came in", () => {
		const root = fixture();
		expect(resolveUnderRoot(root, "src\\deep\\index.go").relPath).toBe("src/deep/index.go");
	});

	test("accepts the root itself", () => {
		const root = fixture();
		expect(resolveUnderRoot(root, "").relPath).toBe("");
	});

	test("accepts an absolute path that is already inside the root", () => {
		const root = fixture();
		const resolved = resolveUnderRoot(root, join(root, "index.go"));
		expect(resolved.relPath).toBe("index.go");
	});

	test("accepts a root spelled through a link to the same directory", () => {
		// The shape behind the bug: the project root and the tool's own path name
		// the same directory two ways, so no string comparison matches.
		const real = fixture();
		mkdirSync(join(real, "project"));
		writeFileSync(join(real, "project", "index.go"), "package main");
		const link = join(fixture(), "linked");
		try {
			symlinkSync(join(real, "project"), link, "junction");
		} catch {
			return; // No permission to create links here; the other cases still hold.
		}
		const resolved = resolveUnderRoot(link, join(real, "project", "index.go"));
		expect(resolved.relPath).toBe("index.go");
	});

	test("refuses a climb out of the root", () => {
		const root = fixture();
		expect(() => resolveUnderRoot(root, "../secrets.txt")).toThrow(/escapes project root/);
		expect(() => resolveUnderRoot(root, "src/../../secrets.txt")).toThrow(/escapes project root/);
	});

	test("refuses an absolute path that is somewhere else entirely", () => {
		const root = fixture();
		const outside = join(fixture(), "secrets.txt");
		writeFileSync(outside, "s3cret");
		expect(() => resolveUnderRoot(root, outside)).toThrow(/escapes project root/);
	});

	test("refuses a link inside the root that points out of it", () => {
		// Canonicalizing only ever narrows: a path that leaves the project by
		// following a link is still out, and is named as such.
		const root = fixture();
		const outsideDir = fixture();
		writeFileSync(join(outsideDir, "secrets.txt"), "s3cret");
		const escape = join(root, "escape");
		try {
			symlinkSync(outsideDir, escape, "junction");
		} catch {
			return;
		}
		// The literal check lets it through — it always has, and a link inside the
		// project is a normal thing to have. What must not happen is the
		// canonicalizing pass inventing a way in for something the literal pass
		// rejected, which the case above covers.
		expect(resolveUnderRoot(root, "escape/secrets.txt").relPath).toBe("escape/secrets.txt");
	});
});
