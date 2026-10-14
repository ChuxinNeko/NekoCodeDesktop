import { randomUUID } from "node:crypto";

import type {
  AgentRole,
  FusionMessage,
  SessionRecord,
  SessionStore,
} from "../core/types.js";

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  async append(
    id: string,
    role: AgentRole,
    message: FusionMessage,
  ): Promise<void> {
    const session = this.#required(id);
    session.contexts[role].push(structuredClone(message));
    session.updatedAt = new Date().toISOString();
  }

  async compact(id: string, role: AgentRole, summary: string): Promise<void> {
    const session = this.#required(id);
    session.contexts[role] = [
      { role: "system", content: `Compacted context: ${summary}` },
    ];
    session.compactions[role] += 1;
    session.updatedAt = new Date().toISOString();
  }

  async create(input: { prompt: string }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      compactions: { main: 0, sidekick: 0 },
      contexts: { main: [], sidekick: [] },
      createdAt: now,
      id: randomUUID(),
      prompt: input.prompt,
      sidekickFailures: 0,
      updatedAt: now,
    };
    this.#sessions.set(session.id, session);
    return structuredClone(session);
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const session = this.#sessions.get(id);
    return session === undefined ? undefined : structuredClone(session);
  }

  async update(
    id: string,
    update: Partial<Pick<SessionRecord, "models" | "sidekickFailures">>,
  ): Promise<void> {
    const session = this.#required(id);
    Object.assign(session, structuredClone(update));
    session.updatedAt = new Date().toISOString();
  }

  #required(id: string): SessionRecord {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      throw new Error(`Session ${id} was not found`);
    }
    return session;
  }
}
