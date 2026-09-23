import { describe, expect, test } from "bun:test";
import type { AgentCell, AgentSnapshot } from "./agent";
import {
	applySnapshotDelta,
	diffSnapshot,
	fingerprintSnapshot,
	SnapshotDeltaCache,
} from "./agent-delta";

function userCell(id: string, text: string): AgentCell {
	return { id, type: "user", text, timestamp: 1 };
}

function assistantCell(id: string, text: string): AgentCell {
	return { id, type: "assistant", text, thinking: "", streaming: false, timestamp: 2 };
}

function snapshot(cells: AgentCell[], overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
	return {
		session: {
			id: "s1",
			sessionFile: "/tmp/s1.jsonl",
			cwd: "/tmp",
			title: "t",
			titlePending: false,
			preview: "",
			createdAt: 0,
			updatedAt: 0,
			messageCount: cells.length,
		},
		cells,
		checkpoints: [],
		fastContext: { modelKey: null, thinkingLevel: "low" },
		workflow: { request: null, todos: [], tasks: [] },
		streaming: false,
		modelKey: "m1",
		models: [{ key: "m1", provider: "p", providerName: "P", id: "m1", name: "M1" }],
		thinkingLevel: "off",
		thinkingLevels: ["off"],
		mode: "auto",
		workMode: "agent",
		agentPhase: "execute",
		...overrides,
	};
}

/** Diff `before` into `after` the way a server would, then apply it back. */
function roundTrip(before: AgentSnapshot, after: AgentSnapshot) {
	const previous = fingerprintSnapshot(before);
	const next = fingerprintSnapshot(after);
	const delta = diffSnapshot(after, next, previous, "v2");
	return { delta, applied: applySnapshotDelta(before, delta) };
}

describe("diffSnapshot / applySnapshotDelta", () => {
	test("sends a full snapshot when there is nothing to diff against", () => {
		const current = snapshot([userCell("c1", "hi")]);
		const delta = diffSnapshot(current, fingerprintSnapshot(current), undefined, "v1");
		expect(delta.full).toEqual(current);
		expect(applySnapshotDelta(null, delta)).toEqual(current);
	});

	test("carries only the changed cell when a message grows", () => {
		const before = snapshot([userCell("c1", "hi"), assistantCell("c2", "he")]);
		const after = snapshot([userCell("c1", "hi"), assistantCell("c2", "hello")]);
		const { delta, applied } = roundTrip(before, after);
		expect(delta.full).toBeUndefined();
		expect(delta.cells).toEqual([assistantCell("c2", "hello")]);
		// Same ids in the same places, so the order does not need restating.
		expect(delta.order).toBeUndefined();
		expect(applied).toEqual(after);
	});

	test("restates the order when a cell is appended", () => {
		const before = snapshot([userCell("c1", "hi")]);
		const after = snapshot([userCell("c1", "hi"), assistantCell("c2", "yo")]);
		const { delta, applied } = roundTrip(before, after);
		expect(delta.cells).toEqual([assistantCell("c2", "yo")]);
		expect(delta.order).toEqual(["c1", "c2"]);
		expect(applied).toEqual(after);
	});

	test("drops cells removed by a rewind", () => {
		const before = snapshot([userCell("c1", "hi"), assistantCell("c2", "yo"), userCell("c3", "again")]);
		const after = snapshot([userCell("c1", "hi")]);
		const { delta, applied } = roundTrip(before, after);
		expect(delta.cells).toBeUndefined();
		expect(delta.order).toEqual(["c1"]);
		expect(applied).toEqual(after);
	});

	test("holds back models and checkpoints until they change", () => {
		const before = snapshot([userCell("c1", "hi")]);
		const after = snapshot([userCell("c1", "hi")], { streaming: true });
		const { delta, applied } = roundTrip(before, after);
		expect(delta.models).toBeUndefined();
		expect(delta.checkpoints).toBeUndefined();
		expect(delta.cells).toBeUndefined();
		expect(applied).toEqual(after);
	});

	test("resends models once the list changes", () => {
		const before = snapshot([userCell("c1", "hi")]);
		const after = snapshot([userCell("c1", "hi")], {
			models: [
				{ key: "m1", provider: "p", providerName: "P", id: "m1", name: "M1" },
				{ key: "m2", provider: "p", providerName: "P", id: "m2", name: "M2" },
			],
		});
		const { delta, applied } = roundTrip(before, after);
		expect(delta.models).toHaveLength(2);
		expect(applied).toEqual(after);
	});

	test("clears a field that the new snapshot no longer carries", () => {
		const before = snapshot([userCell("c1", "hi")], { error: "boom" });
		const after = snapshot([userCell("c1", "hi")]);
		const { applied } = roundTrip(before, after);
		expect(applied?.error).toBeUndefined();
	});

	test("refuses a delta it cannot stitch onto the base", () => {
		const delta = { version: "v2", order: ["c1", "ghost"], rest: undefined };
		expect(applySnapshotDelta(snapshot([userCell("c1", "hi")]), delta)).toBeNull();
	});

	test("refuses a delta when the client holds no base at all", () => {
		expect(applySnapshotDelta(null, { version: "v2" })).toBeNull();
	});

	test("falls back to a full snapshot on duplicate cell ids", () => {
		const current = snapshot([userCell("c1", "hi"), userCell("c1", "hi again")]);
		const previous = fingerprintSnapshot(snapshot([userCell("c1", "hi")]));
		const delta = diffSnapshot(current, fingerprintSnapshot(current), previous, "v2");
		expect(delta.full).toEqual(current);
	});
});

describe("SnapshotDeltaCache", () => {
	test("first call is full, second is a diff against it", () => {
		const cache = new SnapshotDeltaCache("abc");
		const first = cache.next(snapshot([userCell("c1", "hi")]));
		expect(first.full).toBeDefined();
		const second = cache.next(snapshot([userCell("c1", "hi"), assistantCell("c2", "yo")]), first.version);
		expect(second.full).toBeUndefined();
		expect(second.cells).toEqual([assistantCell("c2", "yo")]);
		expect(applySnapshotDelta(first.full!, second)).toEqual(
			snapshot([userCell("c1", "hi"), assistantCell("c2", "yo")]),
		);
	});

	test("an unknown version gets a full snapshot rather than a bad diff", () => {
		const cache = new SnapshotDeltaCache("abc");
		cache.next(snapshot([userCell("c1", "hi")]));
		expect(cache.next(snapshot([userCell("c1", "hi")]), "someone-elses.7").full).toBeDefined();
	});

	test("evicts old versions instead of growing without bound", () => {
		const cache = new SnapshotDeltaCache("abc");
		const stale = cache.next(snapshot([userCell("c1", "hi")]));
		for (let i = 0; i < 20; i++) cache.next(snapshot([userCell("c1", `hi ${String(i)}`)]));
		// The client sat on one version too long; it recovers with a full snapshot.
		expect(cache.next(snapshot([userCell("c1", "hi")]), stale.version).full).toBeDefined();
	});

	test("a version stays usable across the poll that follows it", () => {
		const cache = new SnapshotDeltaCache("abc");
		let held = cache.next(snapshot([userCell("c1", "hi")]));
		let current = held.full!;
		for (let i = 0; i < 30; i++) {
			const next = snapshot([userCell("c1", "hi"), assistantCell("c2", `token ${String(i)}`)]);
			const delta = cache.next(next, held.version);
			expect(delta.full).toBeUndefined();
			current = applySnapshotDelta(current, delta)!;
			expect(current).toEqual(next);
			held = delta;
		}
	});
});
