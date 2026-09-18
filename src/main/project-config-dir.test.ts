import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getProjectConfigDir, LEGACY_CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const projects: string[] = [];

function project(dirs: string[] = []): string {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "nekocode-project-test-"));
	projects.push(root);
	for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
	return root;
}

afterEach(() => {
	const tempRoot = realpathSync(tmpdir());
	for (const root of projects.splice(0)) {
		const target = realpathSync(root);
		if (!target.startsWith(resolve(tempRoot) + sep) || !basename(target).startsWith("nekocode-project-test-")) {
			throw new Error("Refusing unsafe test cleanup");
		}
		rmSync(target, { recursive: true, force: true });
	}
});

/**
 * The kernel is branded to `.nekocode`, but a checkout that already carries pi's
 * `.pi` directory has to keep working: its settings, installed packages,
 * extensions and skills all live there, and the repository is shared with people
 * running upstream pi.
 */
describe("getProjectConfigDir", () => {
	test("the kernel is branded", () => {
		expect(CONFIG_DIR_NAME).toBe(".nekocode");
		expect(LEGACY_CONFIG_DIR_NAME).toBe(".pi");
	});

	test("a project that already uses pi keeps being read from there", () => {
		const root = project([join(".pi", "extensions")]);

		expect(getProjectConfigDir(root)).toBe(join(root, ".pi"));
	});

	test("a branded directory wins when a project carries both", () => {
		const root = project([".pi", ".nekocode"]);

		expect(getProjectConfigDir(root)).toBe(join(root, ".nekocode"));
	});

	test("a project with neither gets the branded name, so new state lands there", () => {
		const root = project();

		expect(getProjectConfigDir(root)).toBe(join(root, ".nekocode"));
	});
});
