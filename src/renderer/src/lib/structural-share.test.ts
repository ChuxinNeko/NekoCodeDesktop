import { describe, expect, it } from "bun:test";
import { shareStructure } from "./structural-share";

const cell = (id: string, text: string) => ({ id, type: "assistant", text, meta: { tokens: [1, 2] } });

describe("shareStructure", () => {
	it("returns the previous value when nothing changed", () => {
		const prev = { cells: [cell("a", "x"), cell("b", "y")], streaming: false };
		const next = structuredClone(prev);
		expect(shareStructure(prev, next)).toBe(prev);
	});

	it("keeps unchanged cells and replaces only the one that moved", () => {
		const prev = { cells: [cell("a", "x"), cell("b", "y")] };
		const next = { cells: [cell("a", "x"), cell("b", "y!")] };
		const shared = shareStructure(prev, next);
		expect(shared).not.toBe(prev);
		expect(shared.cells[0]).toBe(prev.cells[0]);
		expect(shared.cells[1]).not.toBe(prev.cells[1]);
		expect(shared.cells[1].text).toBe("y!");
		// Unchanged nested parts of a changed cell are carried over too.
		expect(shared.cells[1].meta).toBe(prev.cells[1].meta);
	});

	it("matches identified elements by id rather than position", () => {
		const prev = [cell("a", "x"), cell("stream", "partial"), cell("c", "z")];
		const next = [cell("a", "x"), cell("persisted", "done"), cell("c", "z")];
		const shared = shareStructure(prev, next);
		expect(shared[0]).toBe(prev[0]);
		expect(shared[1]).toEqual(next[1]);
		expect(shared[2]).toBe(prev[2]);
	});

	it("treats appended elements and added or removed keys as changes", () => {
		const prev = { cells: [cell("a", "x")], extra: 1 } as Record<string, unknown>;
		const appended = shareStructure(prev, { cells: [cell("a", "x"), cell("b", "y")], extra: 1 });
		expect(appended).not.toBe(prev);
		expect((appended.cells as unknown[])[0]).toBe((prev.cells as unknown[])[0]);
		const removed = shareStructure(prev, { cells: [cell("a", "x")] });
		expect(removed).not.toBe(prev);
		expect("extra" in removed).toBe(false);
		const added = shareStructure({ a: 1 }, { a: 1, b: undefined });
		expect("b" in added).toBe(true);
	});

	it("does not reuse across a type change", () => {
		expect(shareStructure(null, { a: 1 })).toEqual({ a: 1 });
		expect(shareStructure({ a: 1 }, null)).toBeNull();
		expect(shareStructure([1], { 0: 1 })).toEqual({ 0: 1 });
	});
});
