import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Sidebar removals: ACP agents retain ownership of their native transcripts. */
export class AcpDeletedSessions {
	private keys = new Set<string>();
	constructor(private readonly directory?: string) {
		if (!directory) return;
		try {
			const value: unknown = JSON.parse(readFileSync(join(directory, "acp-deleted-sessions.json"), "utf8"));
			if (Array.isArray(value)) this.keys = new Set(value.filter((key): key is string => typeof key === "string"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	has(agentId: string, sessionId: string): boolean {
		return this.keys.has(JSON.stringify([agentId, sessionId]));
	}

	add(agentId: string, sessionId: string): void {
		const next = new Set(this.keys).add(JSON.stringify([agentId, sessionId]));
		if (this.directory) {
			mkdirSync(this.directory, { recursive: true });
			const file = join(this.directory, "acp-deleted-sessions.json");
			const temporary = `${file}.tmp-${process.pid}`;
			try {
				writeFileSync(temporary, `${JSON.stringify([...next])}\n`, { mode: 0o600 });
				renameSync(temporary, file);
			} catch (error) {
				rmSync(temporary, { force: true });
				throw error;
			}
		}
		this.keys = next;
	}
}
