/** Values supported by the portable SQLite storage core. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * A prepared synchronous SQLite statement.
 * Implementations must support repeated execution with new bindings across transactions.
 */
export interface SqliteStatement {
	run(...params: SqliteValue[]): void;
	get<T extends object>(...params: SqliteValue[]): T | undefined;
	all<T extends object>(...params: SqliteValue[]): T[];
}

/**
 * Minimal database facade required by `SqliteStorage`.
 *
 * Queries and transaction callbacks are synchronous so the same storage core can
 * run on Node, Bun, and Cloudflare Durable Object SQLite. An adapter may return a
 * promise from `transaction` while it waits for the transaction to settle.
 * When the callback throws, the adapter must roll the transaction back before
 * rethrowing that same error. If rollback fails, it must throw a different error
 * (for example an `AggregateError`) so callers cannot mistake the callback error
 * for a guaranteed rollback. Callers must not close the database while a
 * returned settlement is pending.
 */
export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	transaction<T>(callback: () => T): T | Promise<T>;
	close(): void | Promise<void>;
}
