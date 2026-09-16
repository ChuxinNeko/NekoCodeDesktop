import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Automation, AutomationRun } from "../../shared/automation";

const DEFINITIONS_FILE = "automations.json";
const RUNS_DIR = "automation-runs";
const MAX_DEFINITIONS = 200;
/** Runs kept per automation; older lines stay on disk but are not read back. */
const RUN_HISTORY_LIMIT = 100;

interface DefinitionsFile {
	version: 1;
	automations: Automation[];
}

/**
 * Persistence for automations and their run history.
 *
 * Definitions live in one atomically-rewritten JSON file. Runs are append-only
 * JSONL, one file per automation: a run is recorded the moment it starts and
 * rewritten on completion, so an interrupted run still leaves a `running` record
 * rather than vanishing.
 */
export class AutomationStore {
	private readonly dir: string;
	private readonly definitionsPath: string;
	private readonly runsDir: string;
	private definitions: Automation[] | null = null;

	constructor(userDataDir: string) {
		this.dir = userDataDir;
		mkdirSync(this.dir, { recursive: true });
		this.definitionsPath = join(this.dir, DEFINITIONS_FILE);
		this.runsDir = join(this.dir, RUNS_DIR);
		mkdirSync(this.runsDir, { recursive: true });
	}

	private load(): Automation[] {
		if (this.definitions) return this.definitions;
		if (!existsSync(this.definitionsPath)) {
			this.definitions = [];
			return this.definitions;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.definitionsPath, "utf8"));
		} catch (error) {
			throw new Error(
				`automations.json 已损坏，不会被覆盖: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const file = parsed as DefinitionsFile;
		if (file.version !== 1 || !Array.isArray(file.automations)) {
			throw new Error("automations.json 结构不符合预期，不会被覆盖");
		}
		this.definitions = file.automations.slice(0, MAX_DEFINITIONS);
		return this.definitions;
	}

	private persist(candidate: Automation[]): void {
		const payload: DefinitionsFile = { version: 1, automations: candidate };
		const tmp = `${this.definitionsPath}.tmp-${String(process.pid)}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.definitionsPath);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
		this.definitions = candidate;
	}

	list(): Automation[] {
		return [...this.load()];
	}

	get(id: string): Automation | undefined {
		return this.load().find((automation) => automation.id === id);
	}

	upsert(automation: Automation): Automation {
		const current = this.load();
		const index = current.findIndex((entry) => entry.id === automation.id);
		if (index === -1) {
			if (current.length >= MAX_DEFINITIONS) throw new Error("自动化数量已达上限");
			this.persist([...current, automation]);
			return automation;
		}
		const next = [...current];
		next[index] = automation;
		this.persist(next);
		return automation;
	}

	remove(id: string): void {
		this.persist(this.load().filter((automation) => automation.id !== id));
		rmSync(this.runsPath(id), { force: true });
	}

	private runsPath(automationId: string): string {
		return join(this.runsDir, `${encodeURIComponent(automationId)}.jsonl`);
	}

	appendRun(run: AutomationRun): void {
		appendFileSync(this.runsPath(run.automationId), `${JSON.stringify(run)}\n`, { mode: 0o600 });
	}

	/** Rewrite the newest line for a run (used when a run finishes). */
	updateRun(run: AutomationRun): void {
		const path = this.runsPath(run.automationId);
		const runs = this.readRuns(run.automationId);
		const index = runs.findIndex((entry) => entry.id === run.id);
		if (index === -1) {
			this.appendRun(run);
			return;
		}
		runs[index] = run;
		const tmp = `${path}.tmp-${String(process.pid)}`;
		try {
			writeFileSync(tmp, runs.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
				mode: 0o600,
			});
			renameSync(tmp, path);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	}

	readRuns(automationId: string): AutomationRun[] {
		const path = this.runsPath(automationId);
		if (!existsSync(path)) return [];
		const runs: AutomationRun[] = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				runs.push(JSON.parse(line) as AutomationRun);
			} catch {
				// Skip a torn line rather than losing the whole history.
			}
		}
		return runs.slice(-RUN_HISTORY_LIMIT);
	}

	newId(): string {
		return randomUUID();
	}
}
