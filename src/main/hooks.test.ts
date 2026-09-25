import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { hookMatches, hookSubject, validateHook, type SaveHookRequest } from "../shared/hooks";
import { HookService, runHookCommand, type HookCommandResult } from "./hooks";

const base = mkdtempSync(join(tmpdir(), "nekocode-hooks-"));
const projectA = join(base, "a");
const projectB = join(base, "b");
mkdirSync(join(projectA, ".git"), { recursive: true });
mkdirSync(projectB, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

const hook = (overrides: Partial<SaveHookRequest>): SaveHookRequest => ({
	name: "h",
	enabled: true,
	event: "pre_tool",
	tools: [],
	pattern: "",
	action: "block",
	command: "",
	message: "",
	project: "",
	timeoutMs: 5000,
	...overrides,
});

/** A HookService whose commands never touch a shell. */
function service(result: (command: string, env: Record<string, string>) => HookCommandResult, dir = "data") {
	const calls: Array<{ command: string; env: Record<string, string>; input: string }> = [];
	const hooks = new HookService(join(base, dir, String(Math.random())), async (options) => {
		calls.push({ command: options.command, env: options.env, input: options.input });
		return result(options.command, options.env);
	});
	return { hooks, calls };
}

describe("matching", () => {
	test("the subject is the command, the path, or the JSON", () => {
		expect(hookSubject("bash", { command: "rm -rf /" })).toBe("rm -rf /");
		expect(hookSubject("edit", { path: "src/a.ts", oldText: "x" })).toBe("src/a.ts");
		expect(hookSubject("mcp_x", { q: 1 })).toBe('{"q":1}');
	});

	test("tools and pattern both have to agree", () => {
		expect(hookMatches({ tools: ["bash"], pattern: "rm\\s+-rf" }, "bash", "RM -RF x")).toBe(true);
		expect(hookMatches({ tools: ["bash"], pattern: "rm" }, "powershell", "rm")).toBe(false);
		expect(hookMatches({ tools: [], pattern: "" }, "anything", "")).toBe(true);
	});

	test("a broken pattern matches nothing rather than everything", () => {
		expect(hookMatches({ tools: [], pattern: "(" }, "bash", "rm -rf")).toBe(false);
	});

	test("validation names the first problem", () => {
		expect(validateHook(hook({ name: "" }))).toBe("name");
		expect(validateHook(hook({ pattern: "[" }))).toBe("pattern");
		expect(validateHook(hook({ action: "command" }))).toBe("command");
		expect(validateHook(hook({ event: "post_tool", action: "block" }))).toBe("command");
		expect(validateHook(hook({ timeoutMs: 10 }))).toBe("timeout");
		expect(validateHook(hook({}))).toBeNull();
	});
});

describe("HookService", () => {
	test("a block rule refuses matching calls with its message", async () => {
		const { hooks, calls } = service(() => ({ code: 0, output: "", timedOut: false }));
		hooks.save(hook({ name: "no rm", tools: ["bash"], pattern: "rm -rf", message: "ask first" }));
		expect(await hooks.beforeTool(projectA, "bash", { command: "rm -rf build" })).toContain("ask first");
		expect(await hooks.beforeTool(projectA, "bash", { command: "ls" })).toBeNull();
		expect(calls).toHaveLength(0);
		expect(hooks.snapshot().recent[0]).toMatchObject({ hookName: "no rm", outcome: "blocked" });
	});

	test("a command pre-hook blocks on a non-zero exit and gets the call's details", async () => {
		const { hooks, calls } = service((command) =>
			command === "deny" ? { code: 2, output: "nope", timedOut: false } : { code: 0, output: "", timedOut: false },
		);
		hooks.save(hook({ name: "gate", action: "command", command: "deny", tools: ["write"] }));
		const refusal = await hooks.beforeTool(projectA, "write", { path: "x.ts", content: "" });
		expect(refusal).toContain("nope");
		expect(calls[0].env.NEKOCODE_FILE).toBe(join(projectA, "x.ts"));
		expect(calls[0].env.NEKOCODE_TOOL).toBe("write");
		expect(JSON.parse(calls[0].input)).toMatchObject({ event: "pre_tool", tool: "write" });
	});

	test("post hooks report only failures", async () => {
		const { hooks } = service((command) =>
			command === "lint" ? { code: 1, output: "1 error", timedOut: false } : { code: 0, output: "ok", timedOut: false },
		);
		hooks.save(hook({ name: "fmt", event: "post_tool", command: "fmt" }));
		expect(await hooks.afterTool(projectA, "edit", { path: "a.ts" })).toBeNull();
		hooks.save(hook({ name: "lint", event: "post_tool", command: "lint" }));
		const note = await hooks.afterTool(projectA, "edit", { path: "a.ts" });
		expect(note).toContain("lint");
		expect(note).toContain("1 error");
	});

	test("disabled hooks and other projects' hooks do not run", async () => {
		const { hooks } = service(() => ({ code: 0, output: "", timedOut: false }));
		hooks.save(hook({ name: "off", enabled: false }));
		hooks.save(hook({ name: "only b", project: projectB }));
		expect(await hooks.beforeTool(join(projectA, "sub"), "bash", { command: "x" })).toBeNull();
		expect(await hooks.beforeTool(projectB, "bash", { command: "x" })).toContain("only b");
	});

	test("save refuses an invalid hook and persists a valid one", () => {
		const dir = join(base, "persist");
		const first = new HookService(dir);
		expect(() => first.save(hook({ name: "" }))).toThrow();
		first.save(hook({ name: "kept", tools: [" bash ", "bash"] }));
		const reloaded = new HookService(dir).list();
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]).toMatchObject({ name: "kept", tools: ["bash"] });
	});

	test("attach wraps both gates and respects an earlier block", async () => {
		const { hooks } = service((command) => ({ code: command === "lint" ? 1 : 0, output: "lint says no", timedOut: false }));
		hooks.save(hook({ name: "no rm", tools: ["bash"], pattern: "rm" }));
		hooks.save(hook({ name: "lint", event: "post_tool", command: "lint", tools: ["edit"] }));
		const agent: {
			beforeToolCall?: (context: unknown, signal?: AbortSignal) => Promise<unknown>;
			afterToolCall?: (context: unknown, signal?: AbortSignal) => Promise<unknown>;
		} = {
			beforeToolCall: async (context) =>
				(context as { toolCall: { name: string } }).toolCall.name === "write" ? { block: true, reason: "mode" } : undefined,
		};
		hooks.attach({ agent } as unknown as AgentSession, projectA);

		expect(await agent.beforeToolCall!({ toolCall: { name: "write" }, args: {} })).toEqual({ block: true, reason: "mode" });
		expect(await agent.beforeToolCall!({ toolCall: { name: "bash" }, args: { command: "rm x" } })).toMatchObject({ block: true });
		expect(await agent.beforeToolCall!({ toolCall: { name: "bash" }, args: { command: "ls" } })).toBeUndefined();

		const after = (await agent.afterToolCall!({
			toolCall: { name: "edit" },
			args: { path: "a.ts" },
			result: { content: [{ type: "text", text: "edited" }] },
			isError: false,
		})) as { content: Array<{ text: string }> };
		expect(after.content.map((c) => c.text).join("")).toContain("lint says no");
		expect(
			await agent.afterToolCall!({ toolCall: { name: "edit" }, args: {}, result: { content: [] }, isError: true }),
		).toBeUndefined();
	});
});

describe("runHookCommand", () => {
	test("runs a real command and reports its exit code and output", async () => {
		const ok = await runHookCommand({ command: "echo hello", cwd: base, env: {}, input: "", timeoutMs: 20_000 });
		expect(ok.code).toBe(0);
		expect(ok.output).toContain("hello");
		const failed = await runHookCommand({ command: "exit 3", cwd: base, env: {}, input: "", timeoutMs: 20_000 });
		expect(failed.code).toBe(3);
	}, 30_000);
});
