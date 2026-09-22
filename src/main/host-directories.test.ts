import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { HOST_DIRECTORY_LIMIT, listHostDirectories } from "./host-directories";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-hostdirs-"));
	dirs.push(dir);
	return dir;
}

describe("listHostDirectories", () => {
	test("lists directories but not files, sorted, with canonical path/root/parent", async () => {
		const dir = fixture();
		mkdirSync(join(dir, "b-two"));
		mkdirSync(join(dir, "a-one"));
		writeFileSync(join(dir, "file.txt"), "x");
		const listing = await listHostDirectories(dir);
		expect(listing.directories.map((d) => d.name)).toEqual(["a-one", "b-two"]);
		expect(listing.directories[0].path).toBe(join(listing.path, "a-one"));
		expect(listing.root).toBe(parse(listing.path).root);
		expect(listing.parent).not.toBeNull();
		expect(listing.truncated).toBe(false);
	});

	test("a filesystem root reports a null parent", async () => {
		const listing = await listHostDirectories(parse(process.cwd()).root);
		expect(listing.parent).toBeNull();
		expect(listing.path).toBe(parse(listing.path).root);
	});

	test("rejects relative paths, files, and missing directories", async () => {
		const dir = fixture();
		writeFileSync(join(dir, "file.txt"), "x");
		await expect(listHostDirectories("relative/path")).rejects.toThrow();
		await expect(listHostDirectories("")).rejects.toThrow();
		await expect(listHostDirectories(join(dir, "file.txt"))).rejects.toThrow("这不是一个文件夹");
		await expect(listHostDirectories(join(dir, "missing"))).rejects.toThrow();
		await expect(listHostDirectories(42)).rejects.toThrow();
	});

	test("follows a symlink that points at a directory", async () => {
		const dir = fixture();
		const target = join(dir, "real");
		mkdirSync(target);
		try {
			symlinkSync(target, join(dir, "linked"), "junction");
		} catch {
			return;
		}
		const listing = await listHostDirectories(dir);
		expect(listing.directories.map((d) => d.name)).toEqual(["linked", "real"]);
	});

	test("marks the listing truncated beyond the limit", async () => {
		const dir = fixture();
		for (let i = 0; i < HOST_DIRECTORY_LIMIT + 1; i++) {
			mkdirSync(join(dir, `d${String(i).padStart(5, "0")}`));
		}
		const listing = await listHostDirectories(dir);
		expect(listing.truncated).toBe(true);
		expect(listing.directories.length).toBe(HOST_DIRECTORY_LIMIT);
	}, 120_000);
});
