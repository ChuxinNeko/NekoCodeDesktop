import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRole, FusionMessage, SessionRecord, SessionStore } from "./reference/core/types";

export const FUSION_ENGINE_SESSION_ENTRY = "nekocode.fusion.engine-session.v1";

/** The reference store contract backed by PI's branch-aware, durable session tree. */
export class PiFusionSessionStore implements SessionStore {
	constructor(private readonly manager: Pick<SessionManager, "getBranch" | "appendCustomEntry">) {}
	async create(input: { prompt: string }): Promise<SessionRecord> {
		const now = new Date().toISOString();
		const record: SessionRecord = { id: randomUUID(), prompt: input.prompt, createdAt: now, updatedAt: now,
			contexts: { main: [], sidekick: [] }, compactions: { main: 0, sidekick: 0 }, sidekickFailures: 0 };
		this.save(record);
		return structuredClone(record);
	}
	async get(id: string): Promise<SessionRecord | undefined> { return this.find(id); }
	latest(): SessionRecord | undefined { return this.find(); }
	async append(id: string, role: AgentRole, message: FusionMessage): Promise<void> {
		const record = this.required(id);
		record.contexts[role].push(structuredClone(message));
		this.save(record);
	}
	async compact(id: string, role: AgentRole, summary: string): Promise<void> {
		const record = this.required(id);
		record.contexts[role] = [{ role: "system", content: `Compacted context: ${summary}` }];
		record.compactions[role]++;
		this.save(record);
	}
	async update(id: string, update: Partial<Pick<SessionRecord, "models" | "sidekickFailures">>): Promise<void> {
		this.save(Object.assign(this.required(id), structuredClone(update)));
	}
	private save(record: SessionRecord): void {
		record.updatedAt = new Date().toISOString();
		this.manager.appendCustomEntry(FUSION_ENGINE_SESSION_ENTRY, structuredClone(record));
	}
	private required(id: string): SessionRecord {
		const record = this.find(id);
		if (!record) throw new Error(`Session ${id} was not found`);
		return record;
	}
	private find(id?: string): SessionRecord | undefined {
		for (const entry of [...this.manager.getBranch()].reverse()) {
			if (entry.type !== "custom" || entry.customType !== FUSION_ENGINE_SESSION_ENTRY) continue;
			const record = entry.data as SessionRecord;
			if (record && typeof record.id === "string" && (!id || record.id === id) &&
				record.contexts && Array.isArray(record.contexts.main) && Array.isArray(record.contexts.sidekick) &&
				record.compactions && Number.isInteger(record.sidekickFailures)) return structuredClone(record);
		}
	}
}
