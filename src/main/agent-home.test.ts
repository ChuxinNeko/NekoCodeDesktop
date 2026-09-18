import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { migrateAgentHome } from "./agent-home";

const homes: string[] = [];

function fakeHome(): string {
	const home = mkdtempSync(join(realpathSync(tmpdir()), "nekocode-home-test-"));
	homes.push(home);
	return home;
}

function write(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

afterEach(() => {
	const tempRoot = realpathSync(tmpdir());
	for (const home of homes.splice(0)) {
		const target = realpathSync(home);
		if (!target.startsWith(resolve(tempRoot) + sep) || !basename(target).startsWith("nekocode-home-test-")) {
			throw new Error("Refusing unsafe test cleanup");
		}
		rmSync(target, { recursive: true, force: true });
	}
});

describe("migrateAgentHome", () => {
	test("carries the old home over, credentials and sessions included", () => {
		const home = fakeHome();
		write(join(home, ".pi", "agent", "auth.json"), '{"openai-codex":{"type":"oauth"}}');
		write(join(home, ".pi", "agent", "sessions", "proj", "a.jsonl"), "{}\n");

		expect(migrateAgentHome(home)).toBe("migrated");

		expect(readFileSync(join(home, ".nekocode", "agent", "auth.json"), "utf8")).toContain("openai-codex");
		expect(existsSync(join(home, ".nekocode", "agent", "sessions", "proj", "a.jsonl"))).toBe(true);
		// Copied, not moved: a separately installed pi CLI keeps its own home.
		expect(existsSync(join(home, ".pi", "agent", "auth.json"))).toBe(true);
		// Nothing half-copied is left lying around under the new home.
		expect(readdirSync(join(home, ".nekocode"))).toEqual(["agent"]);
	});

	test("never overwrites a home that is already in use", () => {
		const home = fakeHome();
		write(join(home, ".pi", "agent", "auth.json"), "old");
		write(join(home, ".nekocode", "agent", "auth.json"), "current");

		expect(migrateAgentHome(home)).toBe("already-present");
		expect(readFileSync(join(home, ".nekocode", "agent", "auth.json"), "utf8")).toBe("current");
	});

	test("a fresh install has nothing to carry over", () => {
		const home = fakeHome();

		expect(migrateAgentHome(home)).toBe("nothing-to-migrate");
		expect(existsSync(join(home, ".nekocode"))).toBe(false);
	});

	test("is a no-op the second time", () => {
		const home = fakeHome();
		write(join(home, ".pi", "agent", "settings.json"), "{}");

		expect(migrateAgentHome(home)).toBe("migrated");
		write(join(home, ".nekocode", "agent", "settings.json"), '{"changed":true}');
		expect(migrateAgentHome(home)).toBe("already-present");
		expect(readFileSync(join(home, ".nekocode", "agent", "settings.json"), "utf8")).toBe('{"changed":true}');
	});
});
