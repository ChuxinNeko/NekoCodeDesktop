import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevServerRegistry, devServerCommand } from "./website-clone-dev-server";

const dirs: string[] = [];
const registries: DevServerRegistry[] = [];

afterAll(async () => {
	for (const registry of registries) registry.stopAll();
	// Give taskkill a moment before the directories it ran in are removed.
	await new Promise((resolve) => setTimeout(resolve, 500));
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function project(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nekocode-dev-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
	return dir;
}

/** A registry whose "dev script" is a node program, so the test needs no npm. */
function registryRunning(script: string): DevServerRegistry {
	const registry = new DevServerRegistry({ commandFor: (root) => `node "${join(root, script)}"` });
	registries.push(registry);
	return registry;
}

describe("devServerCommand", () => {
	test("uses the package manager the lockfile names", async () => {
		const scripts = JSON.stringify({ scripts: { dev: "next dev" } });
		expect(devServerCommand(await project({ "package.json": scripts, "package-lock.json": "{}" }), 3100)).toBe(
			"npm run dev -- --port 3100",
		);
		expect(devServerCommand(await project({ "package.json": scripts, "bun.lock": "" }))).toBe("bun --bun run dev");
		expect(devServerCommand(await project({ "package.json": scripts, "pnpm-lock.yaml": "" }), 4000)).toBe(
			"pnpm run dev --port 4000",
		);
	});

	test("refuses a project without a dev script", async () => {
		const root = await project({ "package.json": JSON.stringify({ scripts: { build: "next build" } }) });
		expect(() => devServerCommand(root)).toThrow("no dev script");
	});
});

describe("DevServerRegistry", () => {
	test("returns the URL the server printed and keeps it running until stopped", async () => {
		const root = await project({
			"server.js": [
				"console.log('\\u001b[32m▲ Next.js\\u001b[39m');",
				"console.log('   - Local:        http://localhost:4317');",
				"setTimeout(() => console.log(' ✓ Ready in 120ms'), 50);",
				"setTimeout(() => console.error(' ⨯ ./src/app/page.tsx: Module not found'), 100);",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		});
		const registry = registryRunning("server.js");
		const started = await registry.start(root, "site");
		expect(started).toMatchObject({ running: true, url: "http://localhost:4317", directory: "site" });
		expect(started.log).toContain("▲ Next.js");

		// Starting again reuses the running server rather than spawning a second.
		expect((await registry.start(root, "site")).url).toBe("http://localhost:4317");

		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(registry.status(root, "site").log).toContain("Module not found");

		const stopped = registry.stop(root, "site");
		expect(stopped.running).toBe(false);
		expect(registry.status(root, "site")).toMatchObject({ running: false, log: "" });
	}, 30_000);

	test("reports a server that exits before it is ready, with its output", async () => {
		const root = await project({
			"crash.js": "console.error('Error: Cannot find module next'); process.exit(1);",
		});
		const registry = registryRunning("crash.js");
		await expect(registry.start(root, "site")).rejects.toThrow("Cannot find module next");
		expect(registry.status(root, "site").running).toBe(false);
	}, 30_000);

	test("maps a wildcard bind address to localhost", async () => {
		const root = await project({
			"wild.js": "console.log('ready - started server on http://0.0.0.0:5190/'); setInterval(() => {}, 1000);",
		});
		const registry = registryRunning("wild.js");
		expect((await registry.start(root, "site")).url).toBe("http://localhost:5190");
		registry.stop(root, "site");
	}, 30_000);
});
