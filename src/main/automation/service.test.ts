import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation, AutomationEvent } from "../../shared/automation";
import type { AutomationRunOutcome } from "./runner";
import { AutomationService, type AutomationRunnerLike } from "./service";

let dir: string;
let clock: number;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nekocode-scheduler-"));
	clock = Date.parse("2026-03-02T09:00:00Z");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Records what the scheduler asked to run, without touching PI. */
class FakeRunner implements AutomationRunnerLike {
	readonly runs: string[] = [];
	reply: AutomationRunOutcome = { summary: "ok", toolCalls: 2, aborted: false };

	run(automation: Automation): Promise<AutomationRunOutcome> {
		this.runs.push(automation.id);
		return Promise.resolve(this.reply);
	}
}

function makeService(runner: FakeRunner, events: AutomationEvent[] = []) {
	const service = new AutomationService({
		userDataDir: dir,
		sessionsDir: dir,
		getModelRuntime: () => Promise.reject(new Error("unused")),
		runner,
		now: () => clock,
		onEvent: (event) => events.push(event),
	});
	return service;
}

function saveInterval(service: AutomationService, minutes: number, enabled = true) {
	return service.save({
		name: `Every ${String(minutes)}m`,
		cwd: dir,
		prompt: "do the thing",
		modelKey: null,
		mode: "read-only",
		schedule: { kind: "interval", minutes },
		enabled,
	});
}

describe("AutomationService scheduling", () => {
	test("does not fire before the first interval elapses", async () => {
		const runner = new FakeRunner();
		const service = makeService(runner);
		saveInterval(service, 60);

		clock += 59 * 60_000;
		await service.runDueAutomations();
		expect(runner.runs).toEqual([]);
	});

	test("fires once the interval has elapsed and records a completed run", async () => {
		const runner = new FakeRunner();
		const events: AutomationEvent[] = [];
		const service = makeService(runner, events);
		const automation = saveInterval(service, 60);

		clock += 61 * 60_000;
		await service.runDueAutomations();
		expect(runner.runs).toEqual([automation.id]);

		const runs = service.runs(automation.id);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("succeeded");
		expect(runs[0]?.toolCalls).toBe(2);
		expect(runs[0]?.summary).toBe("ok");
		expect(events.map((event) => event.kind)).toEqual(["changed", "run-started", "run-finished"]);
	});

	test("measures the next interval from the last run, not from the last tick", async () => {
		const runner = new FakeRunner();
		const service = makeService(runner);
		const automation = saveInterval(service, 60);

		clock += 61 * 60_000;
		await service.runDueAutomations();
		expect(runner.runs).toHaveLength(1);

		// A tick one minute later must not fire again: the next window starts at the run.
		clock += 60_000;
		await service.runDueAutomations();
		expect(runner.runs).toHaveLength(1);

		clock += 60 * 60_000;
		await service.runDueAutomations();
		expect(runner.runs).toHaveLength(2);
		expect(service.get(automation.id)?.nextRunAt).toBeGreaterThan(clock);
	});

	test("ignores disabled automations", async () => {
		const runner = new FakeRunner();
		const service = makeService(runner);
		saveInterval(service, 1, false);

		clock += 10 * 60_000;
		await service.runDueAutomations();
		expect(runner.runs).toEqual([]);
	});

	test("a disabled automation reports no next run", () => {
		const service = makeService(new FakeRunner());
		const enabled = saveInterval(service, 30);
		const disabled = saveInterval(service, 30, false);
		expect(service.get(enabled.id)?.nextRunAt).not.toBeNull();
		expect(service.get(disabled.id)?.nextRunAt).toBeNull();
	});

	test("records a failed run when the runner reports a failure", async () => {
		const runner = new FakeRunner();
		runner.reply = { summary: "", toolCalls: 0, aborted: false, failure: "model exploded" };
		const service = makeService(runner);
		const automation = saveInterval(service, 1);

		clock += 2 * 60_000;
		await service.runDueAutomations();

		const runs = service.runs(automation.id);
		expect(runs[0]?.status).toBe("failed");
		expect(runs[0]?.error).toBe("model exploded");
	});

	test("records an aborted run as aborted rather than failed", async () => {
		const runner = new FakeRunner();
		runner.reply = { summary: "", toolCalls: 0, aborted: true };
		const service = makeService(runner);
		const automation = saveInterval(service, 1);

		clock += 2 * 60_000;
		await service.runDueAutomations();
		expect(service.runs(automation.id)[0]?.status).toBe("aborted");
	});

	test("records the thrown error when the runner rejects", async () => {
		const runner: AutomationRunnerLike = {
			run: () => Promise.reject(new Error("no model configured")),
		};
		const service = makeService(runner as FakeRunner);
		const automation = saveInterval(service, 1);

		clock += 2 * 60_000;
		await service.runDueAutomations();

		const runs = service.runs(automation.id);
		expect(runs[0]?.status).toBe("failed");
		expect(runs[0]?.error).toBe("no model configured");
	});

	test("persists definitions and history across service instances", async () => {
		const runner = new FakeRunner();
		const first = makeService(runner);
		const automation = saveInterval(first, 1);
		clock += 2 * 60_000;
		await first.runDueAutomations();

		const second = makeService(new FakeRunner());
		expect(second.list()).toHaveLength(1);
		expect(second.runs(automation.id)).toHaveLength(1);
	});

	test("survives a restart without re-firing a run that already happened", async () => {
		const runner = new FakeRunner();
		const first = makeService(runner);
		saveInterval(first, 60);
		clock += 61 * 60_000;
		await first.runDueAutomations();
		expect(runner.runs).toHaveLength(1);

		// A new service instance reads the persisted history, so the window restarts
		// from the recorded run rather than the definition's creation time.
		const restartedRunner = new FakeRunner();
		const second = makeService(restartedRunner);
		await second.runDueAutomations();
		expect(restartedRunner.runs).toEqual([]);
	});

	test("runNow fires regardless of the schedule and rejects unknown ids", async () => {
		const runner = new FakeRunner();
		const service = makeService(runner);
		const automation = saveInterval(service, 60);

		await service.runNow(automation.id);
		expect(runner.runs).toEqual([automation.id]);
		expect(service.runs(automation.id)).toHaveLength(1);

		await expect(service.runNow("missing")).rejects.toThrow(/不存在/);
	});

	test("remove drops the definition and its history", () => {
		const service = makeService(new FakeRunner());
		const automation = saveInterval(service, 60);
		service.remove(automation.id);
		expect(service.list()).toEqual([]);
		expect(service.runs(automation.id)).toEqual([]);
	});
});

describe("AutomationService validation", () => {
	test("rejects an empty name, prompt, and cwd", () => {
		const service = makeService(new FakeRunner());
		const base = {
			cwd: dir,
			prompt: "p",
			modelKey: null,
			mode: "read-only" as const,
			schedule: { kind: "interval" as const, minutes: 5 },
			enabled: true,
		};
		expect(() => service.save({ ...base, name: "  " })).toThrow(/名称/);
		expect(() => service.save({ ...base, name: "n", prompt: " " })).toThrow(/提示词/);
		expect(() => service.save({ ...base, name: "n", cwd: " " })).toThrow(/项目目录/);
		expect(() =>
			service.save({ ...base, name: "n", schedule: { kind: "interval", minutes: 0 } }),
		).toThrow(/间隔/);
	});

	test("rejects an out-of-range daily time", () => {
		const service = makeService(new FakeRunner());
		expect(() =>
			service.save({
				name: "n",
				cwd: dir,
				prompt: "p",
				modelKey: null,
				mode: "read-only",
				schedule: { kind: "daily", hour: 24, minute: 0 },
				enabled: true,
			}),
		).toThrow(/小时/);
	});

	test("a cron automation with an unparseable expression never reports a next run", () => {
		const service = makeService(new FakeRunner());
		const saved = service.save({
			name: "cron",
			cwd: dir,
			prompt: "p",
			modelKey: null,
			mode: "read-only",
			schedule: { kind: "cron", expression: "not a cron" },
			enabled: true,
		});
		expect(service.get(saved.id)?.nextRunAt).toBeNull();
	});

	test("lists a running automation as running while its run is in flight", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runner: AutomationRunnerLike = {
			run: async (): Promise<AutomationRunOutcome> => {
				await gate;
				return { summary: "done", toolCalls: 0, aborted: false };
			},
		};
		const service = makeService(runner as FakeRunner);
		const automation = saveInterval(service, 1);

		const pending = service.runNow(automation.id);
		expect(service.get(automation.id)?.running).toBe(true);
		// A concurrent tick must not start a second run for the same automation.
		await service.runDueAutomations();

		release?.();
		await pending;
		expect(service.runs(automation.id)).toHaveLength(1);
		expect(service.get(automation.id)?.running).toBe(false);
	});
});
