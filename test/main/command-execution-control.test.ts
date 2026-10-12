import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as pi from "@earendil-works/pi-coding-agent";
import { CommandExecutionControl } from "../../src/main/command-execution-control";
import { WorkflowRuntime } from "../../src/main/workflow-runtime";

function waitingTool() {
	let aborted = false;
	const tool = {
		name: "bash", label: "bash", description: "test", parameters: {},
		execute: async (_id: string, _args: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
			signal?.addEventListener("abort", () => { aborted = true; reject(new Error("partial output\nCommand aborted")); }, { once: true });
		}),
	} as ToolDefinition;
	return { tool, aborted: () => aborted };
}
const run = (tool: ToolDefinition, id: string, signal?: AbortSignal) =>
	tool.execute(id, { command: "long command" }, signal, undefined, undefined as never);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function runtime() {
	return new WorkflowRuntime({ cwd: process.cwd(), initialMode: "agent", initialFusion: null,
		getPermission: () => "auto", debugRoot: process.cwd(),
		sessionManager: pi.SessionManager.inMemory(process.cwd()), modelRuntime: {} as never,
		onChange: () => undefined, onModeChange: () => undefined });
}

describe("single-command stop", () => {
	test("kills only the selected command, then waits for its reason without aborting the run", async () => {
		let asked = false;
		let answer!: (reason: string) => void;
		const control = new CommandExecutionControl(async () => {
			asked = true;
			return new Promise<string>((resolve) => { answer = resolve; });
		});
		const parent = new AbortController();
		const a = waitingTool();
		const b = waitingTool();
		let settled = false;
		const first = run(control.wrap(a.tool), "a", parent.signal).finally(() => { settled = true; });
		const second = run(control.wrap(b.tool), "b", parent.signal);
		expect(control.stop("missing")).toBe(false);
		expect(control.stop("a")).toBe(true);
		expect(control.stop("a")).toBe(false);
		await tick();
		expect(a.aborted()).toBe(true);
		expect(b.aborted()).toBe(false);
		expect(parent.signal.aborted).toBe(false);
		expect(asked).toBe(true);
		expect(settled).toBe(false);
		answer("命令不符合预期");
		await expect(first).rejects.toThrow("User's reason: 命令不符合预期");
		expect(control.stop("a")).toBe(false);
		parent.abort();
		await expect(second).rejects.toThrow("Command aborted");
	});

	test("normal results and ordinary errors never ask a stop reason", async () => {
		let asks = 0;
		const control = new CommandExecutionControl(async () => { asks++; return "unused"; });
		const result = { content: [{ type: "text" as const, text: "ok" }], details: {} };
		const base = waitingTool().tool;
		expect(await run(control.wrap({ ...base, execute: async () => result }), "ok")).toBe(result);
		await expect(run(control.wrap({ ...base, execute: async () => { throw new Error("timeout:1"); } }), "timeout"))
			.rejects.toThrow("timeout:1");
		expect(control.stop("ok")).toBe(false);
		expect(asks).toBe(0);
	});

	test("whole-run cancellation does not ask why a single command was stopped", async () => {
		let asks = 0;
		const control = new CommandExecutionControl(async () => { asks++; return "unused"; });
		const abort = new AbortController();
		const result = run(control.wrap(waitingTool().tool), "cancel", abort.signal);
		abort.abort();
		await expect(result).rejects.toThrow("Command aborted");
		expect(asks).toBe(0);
		expect(control.stop("cancel")).toBe(false);
	});

	for (const cancelled of [false, true]) {
		test(`runtime forwards ${cancelled ? "cancelled reason inquiry" : "a free-text stop reason"} to the model`, async () => {
			const host = runtime();
			try {
				const result = run(host.commands.wrap(waitingTool().tool), "command");
				expect(host.commands.stop("command")).toBe(true);
				await tick();
				const request = host.state.snapshot().request!;
				expect(request.title).toBe("停止命令的原因");
				expect(request.questions[0].question).toContain("long command");
				host.state.answer({ requestId: request.id, answers: cancelled ? {} : { reason: { text: "不要修改这个目录" } }, cancelled });
				await expect(result).rejects.toThrow(cancelled ? "未提供原因" : "不要修改这个目录");
				expect(host.state.snapshot().request).toBeNull();
			} finally { host.dispose(); }
		});
	}

	test("aborting while the reason card is open settles the tool and closes the card", async () => {
		const host = runtime();
		const abort = new AbortController();
		try {
			const result = run(host.commands.wrap(waitingTool().tool), "command", abort.signal);
			host.commands.stop("command");
			await tick();
			expect(host.state.snapshot().request).not.toBeNull();
			abort.abort();
			await expect(result).rejects.toThrow("Question cancelled");
			expect(host.state.snapshot().request).toBeNull();
			expect(host.commands.stop("command")).toBe(false);
		} finally { host.dispose(); }
	});

	test.if(process.platform === "win32")("real PowerShell is killed before the reason question is shown", async () => {
		const host = runtime();
		const abort = new AbortController();
		try {
			const tool = host.commandTools(pi).find((tool) => tool.name === "powershell")!;
			let ready!: () => void;
			const started = new Promise<void>((resolve) => { ready = resolve; });
			const result = tool.execute("real", { command: "Write-Output 'command-started'; Start-Sleep -Seconds 30" }, abort.signal,
				(update) => { if (JSON.stringify(update).includes("command-started")) ready(); }, undefined as never);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([started, new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Command never started")), 10_000);
				})]);
			} finally { clearTimeout(timer); }
			const stoppedAt = Date.now();
			expect(host.commands.stop("real")).toBe(true);
			for (let i = 0; i < 100 && !host.state.snapshot().request; i++) await new Promise((resolve) => setTimeout(resolve, 20));
			const request = host.state.snapshot().request!;
			expect(request).not.toBeNull();
			expect(Date.now() - stoppedAt).toBeLessThan(3000);
			host.state.answer({ requestId: request.id, answers: { reason: { optionId: "slow" } } });
			await expect(result).rejects.toThrow("运行时间过长");
		} finally {
			abort.abort();
			host.dispose();
		}
	}, 15_000);
});
