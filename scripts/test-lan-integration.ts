import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const output = resolve("out/test-lan/main.cjs");
mkdirSync(dirname(output), { recursive: true });
await build({
	entryPoints: ["scripts/lan-integration.ts"], outfile: output,
	bundle: true, platform: "node", format: "cjs", packages: "external", target: "node22",
	plugins: [{ name: "raw-text", setup(builder) {
		builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw" }));
		builder.onLoad({ filter: /.*/, namespace: "raw" }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
	} }],
});
const testDir = mkdtempSync(join(tmpdir(), "nekocode-lan-integration-"));
const executable = require("electron") as string;
const preview = process.argv.includes("--preview");
const childEnv: NodeJS.ProcessEnv = { ...process.env, NEKOCODE_LAN_TEST_DIR: testDir };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [output, ...(preview ? ["--preview"] : [])], {
	cwd: process.cwd(), windowsHide: true, stdio: "inherit",
	env: childEnv,
});
const timer = preview ? null : setTimeout(() => { child.kill(); process.exitCode = 1; }, 60_000);
child.once("exit", (code) => {
	if (timer) clearTimeout(timer);
	try { rmSync(testDir, { recursive: true, force: true }); } catch { /* Windows may still be releasing locks. */ }
	process.exitCode = code ?? 1;
});
