import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TurnUsage } from "../../shared/agent";
import type { AcpSessionSummary } from "../../shared/acp";

/** Only new prompt responses are recorded; replaying history never spends tokens. */
export class AcpUsageStore {
	constructor(private readonly directory: string) {}

	record(session: AcpSessionSummary, usage: TurnUsage, timestamp: number): void {
		const id = JSON.stringify([session.agentId, session.agentSessionId ?? session.id]);
		// Agent-owned ids need not be safe filenames, nor unique across agents.
		const filename = createHash("sha256").update(id).digest("hex");
		const records = [
			{ type: "session", id: `acp:${id}`, cwd: session.cwd, timestamp },
			{ type: "session_info", name: session.title },
			{ type: "message", timestamp, message: {
				role: "assistant", provider: usage.provider, model: usage.model, usage,
			} },
		];
		mkdirSync(this.directory, { recursive: true });
		appendFileSync(join(this.directory, `${filename}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	}
}
