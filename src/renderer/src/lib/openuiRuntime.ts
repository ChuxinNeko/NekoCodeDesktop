import { openuiToolSchemas, OPENUI_WRITE_TOOLS } from "./openuiToolDefinitions";

export const MAX_OPENUI_STATE_BYTES = 1_000_000;
const MAX_RECORDS = 2000;
type Fields = Record<string, unknown>;
type Row = Record<string, unknown> & { id: string };
type Snapshot = { version: 1; fields: Fields; collections: Record<string, Row[]> };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const empty = (): Snapshot => ({ version: 1, fields: {}, collections: {} });

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function openuiStorageKey(scope: string | undefined, documentId: string | undefined, offset: number): string | undefined {
	return scope && documentId ? `nekocode.openui.v1:${JSON.stringify([scope, documentId, offset])}` : undefined;
}

/** Each reply fence owns its data; the store never exposes raw IPC or fetch. */
export function createOpenUIRuntime(options: {
	key?: string;
	storage?: Storage;
	canWrite?: (tool: string) => boolean;
	readProjectJson?: (path: string) => Promise<unknown>;
	onStorageError?: () => void;
} = {}) {
	let snapshot = empty();
	let writeGuard = options.canWrite;
	let storageError = false;
	const reportStorageError = () => { storageError = true; options.onStorageError?.(); };
	let storage = options.storage;
	if (!storage && typeof window !== "undefined") {
		try { storage = window.localStorage; } catch { reportStorageError(); }
	}
	if (storage && options.key) {
		try {
			const raw = storage.getItem(options.key);
			if (raw && raw.length <= MAX_OPENUI_STATE_BYTES) {
				const parsed: unknown = JSON.parse(raw);
				if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.fields) && isRecord(parsed.collections)) {
					const collections: Record<string, Row[]> = {};
					for (const [name, rows] of Object.entries(parsed.collections)) {
						if (!openuiToolSchemas.app_list.safeParse({ collection: name }).success || !Array.isArray(rows) || rows.length > MAX_RECORDS) continue;
						if (rows.every(row => isRecord(row) && typeof row.id === "string")) collections[name] = rows;
					}
					snapshot = { version: 1, fields: parsed.fields, collections };
				}
			}
		} catch { reportStorageError(); }
	}
	const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
	const persist = (next: Snapshot, requireDurable = false) => {
		const raw = JSON.stringify(next);
		if (new TextEncoder().encode(raw).length > MAX_OPENUI_STATE_BYTES) throw new Error("Application data is too large");
		if (requireDurable && options.key && !storage) throw new Error("Application data could not be saved");
		if (storage && options.key) {
			try { storage.setItem(options.key, raw); } catch {
				reportStorageError();
				if (requireDurable) throw new Error("Application data could not be saved");
			}
		}
		snapshot = next;
	};
	return {
		get storageError() { return storageError; },
		setWriteGuard: (guard: typeof writeGuard) => { writeGuard = guard; },
		getState: () => clone(snapshot.fields),
		setState: (fields: Fields) => {
			try { persist({ ...snapshot, fields: clone(fields) }); } catch { reportStorageError(); }
		},
		async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
			if (OPENUI_WRITE_TOOLS.has(name) && !writeGuard?.(name)) throw new Error("Local writes must be declared as Mutation and run by a button; Query is read-only");
			if (name === "app_list") {
				const { collection } = openuiToolSchemas.app_list.parse(args);
				const rows = Object.hasOwn(snapshot.collections, collection) ? snapshot.collections[collection] : [];
				return { rows: clone(rows), total: rows.length };
			}
			if (name === "app_save") {
				const { collection, record } = openuiToolSchemas.app_save.parse(args);
				const id = record.id === undefined ? crypto.randomUUID() : record.id;
				if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("Invalid record id");
				const rows = [...(Object.hasOwn(snapshot.collections, collection) ? snapshot.collections[collection] : [])];
				const row = { ...clone(record), id };
				const index = rows.findIndex(item => item.id === id);
				if (index === -1) rows.push(row); else rows[index] = row;
				if (rows.length > MAX_RECORDS) throw new Error("Too many application records");
				persist({ ...snapshot, collections: { ...snapshot.collections, [collection]: rows } }, true);
				return { row: clone(row) };
			}
			if (name === "app_delete") {
				const { collection, id } = openuiToolSchemas.app_delete.parse(args);
				const previous = Object.hasOwn(snapshot.collections, collection) ? snapshot.collections[collection] : [];
				const rows = previous.filter(row => row.id !== id);
				persist({ ...snapshot, collections: { ...snapshot.collections, [collection]: rows } }, true);
				return { deleted: previous.length !== rows.length };
			}
			if (name === "project_read_json") {
				const { path } = openuiToolSchemas.project_read_json.parse(args);
				if (!options.readProjectJson) throw new Error("Project data is unavailable in this view");
				return { data: await options.readProjectJson(path) };
			}
			throw new Error(`Unsupported application tool: ${name}`);
		},
	};
}

export type OpenUIRuntime = ReturnType<typeof createOpenUIRuntime>;
