import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteStatement, SqliteValue } from "./database.ts";
import { SqliteStorage } from "./storage.ts";

/** Node SQLite connection settings for a durable storage file. */
export type NodeSqliteStorageOptions = {
	/** SQLite WAL auto-checkpoint threshold. SQLite and this adapter default to 1,000 pages; 0 disables it. */
	readonly walAutoCheckpointPages?: number;
	/** Time SQLite waits for a competing file lock. SQLite defaults to 0; this adapter defaults to 5,000 ms. */
	readonly busyTimeoutMs?: number;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

class NodeSqliteStatement implements SqliteStatement {
	private readonly statement: StatementSync;

	constructor(statement: StatementSync) {
		this.statement = statement;
	}

	run(...params: SqliteValue[]): void {
		this.statement.run(...(params as SQLInputValue[]));
	}

	get<T extends object>(...params: SqliteValue[]): T | undefined {
		return this.statement.get(...(params as SQLInputValue[])) as T | undefined;
	}

	all<T extends object>(...params: SqliteValue[]): T[] {
		return this.statement.all(...(params as SQLInputValue[])) as T[];
	}
}

/** `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. */
export class NodeSqliteDatabase implements SqliteDatabase {
	private readonly database: DatabaseSync;
	private closed = false;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return new NodeSqliteStatement(this.database.prepare(sql));
	}

	transaction<T>(callback: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			if (
				result !== null &&
				(typeof result === "object" || typeof result === "function") &&
				typeof Reflect.get(result, "then") === "function"
			) {
				throw new TypeError("SQLite transaction callbacks must be synchronous");
			}
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
			}
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			this.database.close();
		}
	}
}

/** Open and configure a Node-backed SQLite database facade. */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<NodeSqliteDatabase> {
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const database = new DatabaseSync(path, { timeout });
	const adapter = new NodeSqliteDatabase(database);
	try {
		adapter.exec("PRAGMA journal_mode = WAL");
		adapter.exec("PRAGMA synchronous = NORMAL");
		adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		return adapter;
	} catch (error) {
		try {
			adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		throw error;
	}
}

/** Open or create file-backed durable storage using Node's built-in SQLite. */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(await openNodeSqliteDatabase(path, options));
}
