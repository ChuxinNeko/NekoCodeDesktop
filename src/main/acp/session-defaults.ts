import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Explicit picker selections, isolated by agent and applied only to new sessions. */
export class AcpSessionDefaults {
	private readonly values = new Map<string, Record<string, string>>();

	constructor(private readonly directory?: string) {
		if (!directory) return;
		try {
			const raw: unknown = JSON.parse(readFileSync(join(directory, "acp-session-defaults.json"), "utf8"));
			if (!Array.isArray(raw)) return;
			for (const entry of raw) {
				if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1] || typeof entry[1] !== "object" || Array.isArray(entry[1])) continue;
				this.values.set(entry[0], Object.fromEntries(Object.entries(entry[1]).filter((pair): pair is [string, string] => typeof pair[1] === "string")));
			}
		} catch (error) {
			if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	get(agentId: string): Record<string, string> {
		return { ...this.values.get(agentId) };
	}

	set(agentId: string, configId: string, value: string): void {
		const next = new Map(this.values);
		next.set(agentId, { ...next.get(agentId), [configId]: value });
		if (this.directory) {
			mkdirSync(this.directory, { recursive: true });
			const file = join(this.directory, "acp-session-defaults.json");
			const temporary = `${file}.tmp-${process.pid}`;
			try {
				writeFileSync(temporary, `${JSON.stringify([...next])}\n`, { mode: 0o600 });
				renameSync(temporary, file);
			} catch (error) {
				rmSync(temporary, { force: true });
				throw error;
			}
		}
		this.values.set(agentId, next.get(agentId)!);
	}
}
