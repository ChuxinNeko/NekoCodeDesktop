/**
 * Carry over every part of `prev` that `next` did not change.
 *
 * A snapshot crosses the IPC bridge whole, so every cell in it is a fresh
 * object even when nothing about it moved. React can only skip a row whose
 * props are the *same* object; handing it this instead of the raw snapshot is
 * what lets the settled part of a long transcript sit still while the tail
 * streams.
 *
 * Arrays whose elements carry a string `id` are matched by id, so a cell that
 * shifted position (a streaming cell being replaced by its persisted twin) is
 * still recognised; any other array is matched by index. Whatever is equal
 * comes back as the old reference — all the way up, so an unchanged snapshot
 * returns `prev` itself.
 */
export function shareStructure<T>(prev: unknown, next: T): T {
	return share(prev, next) as T;
}

function share(prev: unknown, next: unknown): unknown {
	if (Object.is(prev, next)) return prev;
	if (Array.isArray(next)) return Array.isArray(prev) ? shareArray(prev, next) : next;
	if (isPlainObject(next)) return isPlainObject(prev) ? shareObject(prev, next) : next;
	return next;
}

function shareArray(prev: unknown[], next: unknown[]): unknown[] {
	const byId = idIndex(prev);
	let same = prev.length === next.length;
	const out = next.map((item, index) => {
		const id = idOf(item);
		const match = byId && id !== undefined ? byId.get(id) : prev[index];
		const shared = share(match, item);
		if (shared !== prev[index]) same = false;
		return shared;
	});
	return same ? prev : out;
}

function shareObject(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
	const keys = Object.keys(next);
	let same = keys.length === Object.keys(prev).length;
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const shared = share(prev[key], next[key]);
		if (shared !== prev[key] || !(key in prev)) same = false;
		out[key] = shared;
	}
	return same ? prev : out;
}

/** Old elements by id, or null when the array is not one of identified records. */
function idIndex(items: unknown[]): Map<string, unknown> | null {
	if (items.length === 0 || idOf(items[0]) === undefined) return null;
	const map = new Map<string, unknown>();
	for (const item of items) {
		const id = idOf(item);
		if (id !== undefined) map.set(id, item);
	}
	return map;
}

function idOf(item: unknown): string | undefined {
	if (!isPlainObject(item)) return undefined;
	const id = item.id;
	return typeof id === "string" ? id : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
