import { describe, expect, test } from "bun:test";
import type { AgentCell } from "../../src/shared/agent";
import { acceptanceMarkdown, buildAcceptanceReport, isValidationCommand } from "../../src/shared/acceptance";

const user = (id = "u1", timestamp = 1): AgentCell => ({ id, type: "user", text: "Implement the settings search", timestamp });
const tool = (id: string, name: string, args: unknown, timestamp: number, details?: unknown, status: "done" | "error" | "running" = "done", startedAt = timestamp): AgentCell =>
	({ id: `tool-${id}`, type: "tool", toolCallId: id, toolName: name, args, timestamp, startedAt, status, output: "actual output", details });
const command = (id: string, timestamp: number, exitCode?: number, status: "done" | "error" | "running" = "done", startedAt = timestamp) =>
	tool(id, "powershell", { command: "bun run typecheck" }, timestamp, exitCode === undefined ? {} : { execution: { exitCode } }, status, startedAt);
const current = (cells: AgentCell[], streaming = false) => buildAcceptanceReport(cells, streaming).turns.at(-1)!;

describe("acceptance evidence", () => {
	test("only structured execution status can pass a command", () => {
		const turn = current([user(), command("unknown", 2), command("pass", 3, 0), command("fail", 4, 2), command("error", 5, 0, "error")]);
		expect(turn.checks.map(check => check.status)).toEqual(["unverified", "passed", "failed", "failed"]);
		expect(turn.checks[1].exitCode).toBe(0);
	});
	test("prose, page navigation and successful arbitrary evaluation are not passing checks", () => {
		const turn = current([user(), { id: "answer", type: "assistant", text: "All tests passed", thinking: "", streaming: false, timestamp: 2 },
			tool("nav", "browser_navigate", {}, 3), tool("eval", "browser_evaluate", { expression: "true" }, 4)]);
		expect(turn.checks).toEqual([]);
	});
	test("a compound shell's final zero exit code cannot mask a failed check or subsequent edit", () => {
		for (const command of ["bun test; echo ok", "bun test || true", "bun test && python change.py", "bun test > a.ts"]) {
			const turn = current([user(), tool("check", "bash", { command }, 2, { execution: { exitCode: 0 } })]);
			expect(turn.checks[0].status).toBe("unverified");
		}
	});
	test("edits after a check starts invalidate it, even when they finish before the check", () => {
		const turn = current([user(), command("old", 6, 0, "done", 2), tool("write", "edit", { path: "src/app.ts" }, 4), command("fresh", 7, 0)]);
		expect(turn.checks.map(check => check.status)).toEqual(["stale", "passed"]);
		expect(turn.checks[0].previousStatus).toBe("passed");
		expect(turn.changedPaths).toEqual(["src/app.ts"]);
	});
	test("later turns invalidate earlier evidence and read-only commands do not", () => {
		const cells = [user(), command("check", 2, 0), tool("status", "bash", { command: "git status --short" }, 3)];
		expect(current(cells).checks[0].status).toBe("passed");
		const report = buildAcceptanceReport([...cells, user("u2", 4), tool("write", "write", { path: "a.ts" }, 5)]);
		expect(report.turns[0].checks[0].status).toBe("stale");
	});
	test("unknown commands and mixed validation/mutation chains invalidate conservatively", () => {
		for (const mutation of ["python change.py", "bun test && python change.py", "cat script | sh", "git status > state.txt"]) {
			const turn = current([user(), command("check", 2, 0), tool("shell", "bash", { command: mutation }, 3)]);
			expect(turn.checks[0].status).toBe("stale");
			expect(turn.possibleShellChanges).toBe(true);
		}
	});
	test("stopped runs do not leave command checks running forever", () => {
		expect(current([user(), command("check", 2, undefined, "running")], true).checks[0].status).toBe("running");
		expect(current([user(), command("check", 2, undefined, "running")]).checks[0].status).toBe("unverified");
		expect(current([user(), { ...command("aborted", 2, undefined, "error"), output: "Command aborted" } as AgentCell]).checks[0].status).toBe("unverified");
	});
	test("requirement updates replace plans and derive status from linked evidence", () => {
		const declaration = (status: string, ids: string[], timestamp: number) => tool(`r${timestamp}`, "acceptance_check", {}, timestamp,
			{ acceptanceRecord: { id: "types", title: "Types compile", status, evidenceToolCallIds: ids } });
		const cells = [user(), declaration("pending", [], 2), command("check", 3, 0), declaration("passed", ["check"], 4)];
		expect(current(cells).checks.filter(check => check.kind === "requirement").map(check => check.status)).toEqual(["passed"]);
		cells.push(tool("change", "edit", { path: "x.ts" }, 5));
		expect(current(cells).checks.every(check => check.status === "stale")).toBe(true);
		expect(current([user(), declaration("passed", ["missing"], 2)]).checks[0].status).toBe("unverified");
	});
	test("explicitly referenced custom validation commands have evidence, without classifying every read as a test", () => {
		const cells = [user(), tool("custom", "bash", { command: "node scripts/verify.cjs" }, 2, { execution: { exitCode: 0 } })];
		expect(current(cells).checks).toEqual([]);
		cells.push(tool("r", "acceptance_check", {}, 3, { acceptanceRecord: { id: "custom", title: "Custom check", status: "passed", evidenceToolCallIds: ["custom"] } }));
		expect(current(cells).checks.map(check => check.status)).toEqual(["passed", "passed"]);
	});
	test("browser assertions retain URL, viewport and actual failure", () => {
		const turn = current([user(), tool("browser", "browser_check", {}, 2, { acceptanceEvidence: { title: "Mobile form", status: "failed", url: "http://localhost:5173", viewport: { width: 390, height: 844 } } })]);
		expect(turn.checks[0]).toMatchObject({ status: "failed", url: "http://localhost:5173", viewport: { width: 390, height: 844 } });
		expect(acceptanceMarkdown(turn)).toContain("390 × 844");
	});
	test("snapshot reports are bounded while retaining truncation notices", () => {
		const cells: AgentCell[] = [];
		for (let i = 0; i < 12; i++) {
			cells.push(user(`u${i}`, i * 100));
			for (let j = 1; j < 40; j++) cells.push({ ...command(`${i}:${j}`, i * 100 + j, 0), output: "x".repeat(5000) } as AgentCell);
		}
		const report = buildAcceptanceReport(cells);
		expect(report.turns).toHaveLength(8);
		expect(report.omittedTurns).toBe(4);
		expect(report.turns.flatMap(turn => turn.checks)).toHaveLength(30);
		expect(report.turns.at(-1)?.omittedChecks).toBeGreaterThan(0);
		expect(report.turns.at(-1)?.checks[0].outputTruncated).toBe(true);
		expect(JSON.stringify(report).length).toBeLessThan(80_000);
	});
	test("recognizes checks without interpreting echo text as execution", () => {
		for (const value of ["bun test test/foo.ts", "npm run lint", "pnpm run build", "npx tsc --noEmit", "python -m pytest", "cargo test"]) expect(isValidationCommand(value)).toBe(true);
		for (const value of ["echo bun test", "echo 'example; bun test'", "cat test.txt", "npm install", "git status"]) expect(isValidationCommand(value)).toBe(false);
	});
});
