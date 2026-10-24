import { expect, test } from "bun:test";
import type { AgentCell } from "../../src/shared/agent";
import { createAcceptanceTool } from "../../src/main/acceptance-tool";
import { CommandExecutionControl } from "../../src/main/command-execution-control";
import * as pi from "@earendil-works/pi-coding-agent";
import { commandShellSetup } from "../../src/main/command-shell";

test("acceptance declarations reject unsupported passing claims, skipped checks without reasons and old-turn evidence", async () => {
	const cells: AgentCell[] = [{ id: "u", type: "user", text: "Task", timestamp: 1 }];
	const tool = createAcceptanceTool(() => cells);
	const run = (params: object) => tool.execute("declare", { id: "types", title: "Compile types", ...params }, undefined, undefined, {} as never);
	await expect(run({ status: "passed" })).rejects.toThrow("Evidence does not support");
	await expect(run({ status: "skipped" })).rejects.toThrow("require a reason");
	expect((await run({ status: "skipped", reason: "No compiler available" })).details).toMatchObject({ acceptanceRecord: { status: "skipped" } });
	cells.push({ id: "tool-check", type: "tool", toolCallId: "check", toolName: "bash", args: { command: "node custom-check.cjs" }, output: "ok", status: "done", timestamp: 3, details: { execution: { exitCode: 0 } } });
	expect((await run({ status: "passed", evidenceToolCallIds: ["check"] })).details).toMatchObject({ acceptanceRecord: { status: "passed" } });
	cells.push({ id: "u2", type: "user", text: "Next task", timestamp: 4 });
	await expect(run({ status: "passed", evidenceToolCallIds: ["check"] })).rejects.toThrow("current turn");
});

test("process evidence survives persistence in tool details", async () => {
	const control = new CommandExecutionControl(async () => "unused");
	const tool = control.wrap({ name: "bash", label: "bash", description: "test", parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "actual output" }], details: { fullOutputPath: "/tmp/log" }, structuredContent: { exit_code: 0, wall_time_seconds: 1.2 } }),
	} as never);
	const result = await tool.execute("cmd", {}, undefined, undefined, {} as never);
	expect(result.details).toEqual({ fullOutputPath: "/tmp/log", execution: { exitCode: 0, wallTimeSeconds: 1.2 } });
});

test("the configured native shell supplies actual success and failure exit codes", async () => {
	const windows = process.platform === "win32";
	const shell = commandShellSetup(windows ? "powershell" : "sh");
	const control = new CommandExecutionControl(async () => "unused");
	const definition = windows ? pi.createPowerShellToolDefinition(process.cwd(), shell.toolOptions.powershell) : pi.createBashToolDefinition(process.cwd(), shell.toolOptions.bash);
	const tool = control.wrap(definition as never);
	for (const code of [0, 7]) {
		const command = windows ? `Write-Output 'acceptance-smoke'; exit ${code}` : `printf acceptance-smoke; exit ${code}`;
		const result = await tool.execute(`native-${code}`, { command }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ execution: { exitCode: code } });
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("acceptance-smoke") }));
	}
}, 15_000);
