import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DiagnosticLog, diagnosticError } from "../../src/main/diagnostic-log";

const directories: string[] = [];
function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "neko-diagnostics-"));
	directories.push(directory);
	return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("writes fatal-path records synchronously with timestamp and process identity", () => {
	const log = new DiagnosticLog(join(temporaryDirectory(), "logs"));
	log.write("nekolocal.agent_start", { sessionId: "example" });
	const record = JSON.parse(readFileSync(log.path, "utf8"));
	expect(record).toMatchObject({ event: "nekolocal.agent_start", pid: process.pid, details: { sessionId: "example" } });
	expect(Number.isFinite(Date.parse(record.timestamp))).toBe(true);
});

test("rotation retains the latest records and bounds disk usage to four files", () => {
	const directory = temporaryDirectory();
	const log = new DiagnosticLog(directory, 256);
	for (let index = 0; index < 12; index++) log.write("sample", { index, padding: "x".repeat(60) });
	const files = readdirSync(directory);
	expect(files.sort()).toEqual(["diagnostics.jsonl", "diagnostics.jsonl.1", "diagnostics.jsonl.2", "diagnostics.jsonl.3"]);
	expect(JSON.parse(readFileSync(log.path, "utf8")).details.index).toBe(11);
	for (const file of files) expect(readFileSync(join(directory, file)).byteLength).toBeLessThanOrEqual(256);
});

test("oversized and unserializable records cannot break subsequent writes", () => {
	const log = new DiagnosticLog(temporaryDirectory(), 256);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	expect(() => log.write("circular", circular)).not.toThrow();
	expect(() => log.write("oversized", { text: "x".repeat(1024) })).not.toThrow();
	log.write("next");
	expect(JSON.parse(readFileSync(log.path, "utf8")).event).toBe("next");
});

test("a filesystem failure never escapes the diagnostic writer", () => {
	const blocker = join(temporaryDirectory(), "file");
	writeFileSync(blocker, "not a directory");
	expect(() => new DiagnosticLog(blocker).write("failure")).not.toThrow();
});

test("error metadata bounds stack and message size", () => {
	const error = new Error("x".repeat(20000));
	const details = diagnosticError(error);
	expect((details.message as string).length).toBe(2048);
	expect((details.stack as string).length).toBeLessThanOrEqual(8192);
});

for (const [origin, trigger] of [
	["uncaughtException", "setImmediate(() => { throw new Error('diagnostic-fatal-test'); });"],
	["unhandledRejection", "Promise.reject(new Error('diagnostic-fatal-test'));"],
] as const) {
	test(`records ${origin} without suppressing Node's nonzero exit`, async () => {
		const directory = temporaryDirectory();
		const fixture = join(directory, "fatal.mjs");
		const build = await Bun.build({ entrypoints: [resolve("src/main/diagnostic-log.ts")], target: "node", format: "esm" });
		expect(build.success).toBe(true);
		writeFileSync(fixture, `${await build.outputs[0].text()}\nobserveProcessDiagnostics(new DiagnosticLog(process.argv[2]));\n${trigger}\n`);
		const result = spawnSync("node", ["--unhandled-rejections=throw", fixture, directory], { encoding: "utf8", windowsHide: true, timeout: 10000 });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		const records = readFileSync(join(directory, "diagnostics.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(records[0]).toMatchObject({ event: "process.uncaughtException", details: { origin, message: "diagnostic-fatal-test" } });
		expect(records[1]).toMatchObject({ event: "process.exit", details: { code: 1 } });
	});
}
