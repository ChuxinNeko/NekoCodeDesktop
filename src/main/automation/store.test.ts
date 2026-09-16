import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation, AutomationRun } from "../../shared/automation";
import { AutomationStore } from "./store";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nekocode-automation-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function automation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "auto-1",
		name: "Nightly triage",
		cwd: "/tmp/project",
		prompt: "Summarize open issues.",
		modelKey: null,
		mode: "read-only",
		schedule: { kind: "daily", hour: 9, minute: 0 },
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
	return {
		id: "run-1",
		automationId: "auto-1",
		startedAt: 1_000,
		status: "running",
		summary: "",
		toolCalls: 0,
		...overrides,
	};
}

describe("AutomationStore", () => {
	test("round-trips definitions through a fresh store instance", () => {
		const store = new AutomationStore(dir);
		store.upsert(automation());
		expect(new AutomationStore(dir).list()).toHaveLength(1);
		expect(new AutomationStore(dir).get("auto-1")?.name).toBe("Nightly triage");
	});

	test("upsert replaces in place instead of appending", () => {
		const store = new AutomationStore(dir);
		store.upsert(automation());
		store.upsert(automation({ name: "Renamed" }));
		const list = store.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe("Renamed");
	});

	test("remove drops the definition and its run history", () => {
		const store = new AutomationStore(dir);
		store.upsert(automation());
		store.appendRun(run());
		store.remove("auto-1");
		expect(store.list()).toHaveLength(0);
		expect(store.readRuns("auto-1")).toEqual([]);
	});

	test("refuses to overwrite a corrupt definitions file", () => {
		writeFileSync(join(dir, "automations.json"), "{ not json");
		const store = new AutomationStore(dir);
		expect(() => store.list()).toThrow(/已损坏/);
		expect(readFileSync(join(dir, "automations.json"), "utf8")).toBe("{ not json");
	});

	test("rejects a definitions file with an unexpected shape", () => {
		writeFileSync(join(dir, "automations.json"), JSON.stringify({ version: 2, automations: [] }));
		expect(() => new AutomationStore(dir).list()).toThrow(/结构不符合预期/);
	});

	test("appends runs and rewrites a run when it finishes", () => {
		const store = new AutomationStore(dir);
		store.upsert(automation());
		store.appendRun(run());
		store.updateRun(run({ status: "succeeded", finishedAt: 2_000, summary: "done" }));
		const runs = store.readRuns("auto-1");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("succeeded");
		expect(runs[0]?.summary).toBe("done");
	});

	test("keeps an interrupted run recorded as running", () => {
		const store = new AutomationStore(dir);
		store.upsert(automation());
		store.appendRun(run());
		// A crash before updateRun must leave the record, not drop it.
		expect(new AutomationStore(dir).readRuns("auto-1")[0]?.status).toBe("running");
	});

	test("skips a torn JSONL line instead of losing the whole history", () => {
		const store = new AutomationStore(dir);
		store.upsert(automation());
		store.appendRun(run());
		store.appendRun(run({ id: "run-2", startedAt: 2_000 }));
		const path = join(dir, "automation-runs", "auto-1.jsonl");
		writeFileSync(path, `${readFileSync(path, "utf8")}{"id":"run-3","partial`);
		const runs = store.readRuns("auto-1");
		expect(runs.map((entry) => entry.id)).toEqual(["run-1", "run-2"]);
	});
});
