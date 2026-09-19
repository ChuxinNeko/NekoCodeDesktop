import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { NEKOCODE_TOOL_OPTIONS, sanitizeNekoShellEnvironment } from "./shell-environment";

function context(env: NodeJS.ProcessEnv): BashSpawnContext {
	return { command: "npm run build", cwd: "D:\\work\\project", env };
}

describe("sanitizeNekoShellEnvironment", () => {
	test("removes a leaked NODE_ENV", () => {
		const result = sanitizeNekoShellEnvironment(context({ NODE_ENV: "development", HOME: "h" }));
		expect(result.env.NODE_ENV).toBeUndefined();
		expect(result.env.HOME).toBe("h");
	});

	test("removes quoted and unquoted bun-node PATH shims on every PATH-style key", () => {
		const path = [
			"C:\\Program Files\\nodejs",
			"C:\\Users\\me\\AppData\\Local\\Temp\\bun-node-abc123",
			'"C:\\Users\\me\\AppData\\Local\\Temp\\bun-node-def456\\"',
			"C:\\tools\\bin",
		].join(delimiter);
		const result = sanitizeNekoShellEnvironment(
			context({ PATH: path, Path: "C:\\other\\bun-node-xyz" + delimiter + "C:\\keep" }),
		);
		expect(result.env.PATH).toBe(
			["C:\\Program Files\\nodejs", "C:\\tools\\bin"].join(delimiter),
		);
		expect(result.env.Path).toBe("C:\\keep");
	});

	test("does not remove lookalike directory names", () => {
		const path = ["C:\\src\\my-bun-node-app", "C:\\src\\bun-node"].join(delimiter);
		const result = sanitizeNekoShellEnvironment(context({ PATH: path }));
		expect(result.env.PATH).toBe(path);
	});

	test("preserves command, cwd, and unrelated environment", () => {
		const input = context({ USER: "dev", CUSTOM_FLAG: "1" });
		const result = sanitizeNekoShellEnvironment(input);
		expect(result.command).toBe(input.command);
		expect(result.cwd).toBe(input.cwd);
		expect(result.env.USER).toBe("dev");
		expect(result.env.CUSTOM_FLAG).toBe("1");
	});

	test("does not mutate the input context or env", () => {
		const env = { NODE_ENV: "development", PATH: "C:\\bun-node-9" };
		const input = context(env);
		sanitizeNekoShellEnvironment(input);
		expect(input.env).toBe(env);
		expect(env.NODE_ENV).toBe("development");
		expect(env.PATH).toBe("C:\\bun-node-9");
	});
});

describe("NEKOCODE_TOOL_OPTIONS", () => {
	test("wires the sanitizer as the spawn hook for both shells", () => {
		expect(NEKOCODE_TOOL_OPTIONS.bash?.spawnHook).toBe(sanitizeNekoShellEnvironment);
		expect(NEKOCODE_TOOL_OPTIONS.powershell?.spawnHook).toBe(sanitizeNekoShellEnvironment);
	});
});
