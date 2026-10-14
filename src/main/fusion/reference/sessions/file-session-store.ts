import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentRole,
  FusionMessage,
  SessionRecord,
  SessionStore,
} from "../core/types.js";

interface FileSessionStoreOptions {
  directory: string;
  idFactory?: () => string;
  now?: () => string;
}

export class FileSessionStore implements SessionStore {
  readonly #directory: string;
  readonly #idFactory: () => string;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #now: () => string;

  constructor(options: FileSessionStoreOptions) {
    this.#directory = options.directory;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async append(
    id: string,
    role: AgentRole,
    message: FusionMessage,
  ): Promise<void> {
    await this.#mutate(id, (session) => {
      session.contexts[role].push(structuredClone(message));
    });
  }

  async compact(id: string, role: AgentRole, summary: string): Promise<void> {
    await this.#mutate(id, (session) => {
      session.contexts[role] = [
        { role: "system", content: `Compacted context: ${summary}` },
      ];
      session.compactions[role] += 1;
    });
  }

  async create(input: { prompt: string }): Promise<SessionRecord> {
    const id = this.#idFactory();
    assertSessionId(id);
    const now = this.#now();
    const session: SessionRecord = {
      compactions: { main: 0, sidekick: 0 },
      contexts: { main: [], sidekick: [] },
      createdAt: now,
      id,
      prompt: input.prompt,
      sidekickFailures: 0,
      updatedAt: now,
    };
    await this.#enqueue(id, async () => this.#write(session));
    return structuredClone(session);
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    await this.#enqueue(id, async () => {
      try {
        await unlink(this.#path(id));
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    });
  }

  async fork(id: string): Promise<SessionRecord> {
    const source = await this.#required(id);
    const forkId = this.#idFactory();
    assertSessionId(forkId);
    const now = this.#now();
    const fork: SessionRecord = {
      ...structuredClone(source),
      createdAt: now,
      id: forkId,
      updatedAt: now,
    };
    await this.#enqueue(forkId, async () => this.#write(fork));
    return structuredClone(fork);
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    assertSessionId(id);
    await this.#locks.get(id);
    return this.#read(id);
  }

  async list(): Promise<SessionRecord[]> {
    await mkdir(this.#directory, { recursive: true });
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => this.get(entry.name.slice(0, -5))),
    );
    return sessions
      .filter((session): session is SessionRecord => session !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async update(
    id: string,
    update: Partial<Pick<SessionRecord, "models" | "sidekickFailures">>,
  ): Promise<void> {
    await this.#mutate(id, (session) => {
      Object.assign(session, structuredClone(update));
    });
  }

  async #mutate(
    id: string,
    mutate: (session: SessionRecord) => void,
  ): Promise<void> {
    assertSessionId(id);
    await this.#enqueue(id, async () => {
      const session = await this.#requiredUnlocked(id);
      mutate(session);
      session.updatedAt = this.#now();
      await this.#write(session);
    });
  }

  async #enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const queued = previous.then(operation, operation);
    this.#locks.set(
      id,
      queued.then(
        () => undefined,
        () => undefined,
      ),
    );
    return queued;
  }

  async #required(id: string): Promise<SessionRecord> {
    const session = await this.get(id);
    if (session === undefined) {
      throw new Error(`Session ${id} was not found`);
    }
    return session;
  }

  async #requiredUnlocked(id: string): Promise<SessionRecord> {
    const session = await this.#read(id);
    if (session === undefined) {
      throw new Error(`Session ${id} was not found`);
    }
    return session;
  }

  async #read(id: string): Promise<SessionRecord | undefined> {
    try {
      const content = await readFile(this.#path(id), "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!isSessionRecord(parsed)) {
        throw new Error("invalid session schema");
      }
      return structuredClone(parsed);
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw new Error(`Session ${id} could not be read`, { cause: error });
    }
  }

  async #write(session: SessionRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const path = this.#path(session.id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  #path(id: string): string {
    return join(this.#directory, `${id}.json`);
  }
}

function assertSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: string }).code === "ENOENT"
  );
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value as Partial<SessionRecord>;
  return (
    typeof session.id === "string" &&
    typeof session.prompt === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string" &&
    typeof session.sidekickFailures === "number" &&
    isRoleRecord(session.compactions, (item) => typeof item === "number") &&
    isRoleRecord(
      session.contexts,
      (item) => Array.isArray(item) && item.every(isFusionMessage),
    )
  );
}

function isRoleRecord(
  value: unknown,
  validate: (item: unknown) => boolean,
): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return validate(record.main) && validate(record.sidekick);
}

function isFusionMessage(value: unknown): value is FusionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Partial<FusionMessage>;
  return (
    typeof message.content === "string" &&
    (message.role === "assistant" ||
      message.role === "system" ||
      message.role === "user")
  );
}
