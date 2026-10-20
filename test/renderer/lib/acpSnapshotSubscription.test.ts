import { expect, test } from "bun:test";
import type { AcpSessionSnapshot } from "../../../src/shared/acp";
import { subscribeAcpSnapshot } from "../../../src/renderer/src/lib/acpSnapshotSubscription";

function snapshot(id: string, text: string): AcpSessionSnapshot {
	return {
		id, agentId: "codex", agentName: "Codex", cwd: "/project", title: id,
		status: "prompting", pristine: false, createdAt: 1, updatedAt: 1,
		cells: [{ id: "user-1", type: "user", text, timestamp: 1 }],
		streaming: true, configOptions: [], commands: [], permissions: [], supportsImages: true,
	};
}

function source() {
	const listeners = new Set<(value: AcpSessionSnapshot) => void>();
	const reads = new Map<string, (value: AcpSessionSnapshot | null) => void>();
	return {
		acpSnapshot: (id: string) => new Promise<AcpSessionSnapshot | null>((resolve) => reads.set(id, resolve)),
		onAcpSnapshot: (listener: (value: AcpSessionSnapshot) => void) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		push: (value: AcpSessionSnapshot) => { for (const listener of listeners) listener(value); },
		read: (id: string, value: AcpSessionSnapshot | null) => reads.get(id)!(value),
	};
}

test("concurrent Codex panes keep interleaved bursts and identical cell IDs isolated", async () => {
	const api = source();
	const a: AcpSessionSnapshot[] = [];
	const b: AcpSessionSnapshot[] = [];
	const stopA = subscribeAcpSnapshot(api, "a", (next) => { if (next) a.push(next); });
	const stopB = subscribeAcpSnapshot(api, "b", (next) => { if (next) b.push(next); });
	for (let i = 0; i < 1000; i++) {
		api.push(snapshot("a", `A-${i}`));
		api.push(snapshot("b", `B-${i}`));
	}
	api.read("b", snapshot("b", "old B"));
	api.read("a", snapshot("a", "old A"));
	await Promise.resolve();
	expect(a).toHaveLength(1000);
	expect(b).toHaveLength(1000);
	expect(a.every((next) => next.id === "a")).toBe(true);
	expect(b.every((next) => next.id === "b")).toBe(true);
	expect(a.at(-1)?.cells[0]).toMatchObject({ text: "A-999" });
	expect(b.at(-1)?.cells[0]).toMatchObject({ text: "B-999" });
	stopA(); stopB();
});

test("switching sessions ignores the previous session's delayed read and stream", async () => {
	const api = source();
	const seen: Array<AcpSessionSnapshot | null> = [];
	const stopA = subscribeAcpSnapshot(api, "a", (next) => seen.push(next));
	stopA();
	const stopB = subscribeAcpSnapshot(api, "b", (next) => seen.push(next));
	api.read("b", snapshot("b", "B"));
	api.read("a", snapshot("a", "A"));
	api.push(snapshot("a", "late A"));
	await Promise.resolve();
	expect(seen.map((next) => next?.id)).toEqual(["b"]);
	stopB();
});

test("a delayed missing-session result does not clear a live streamed session", async () => {
	const api = source();
	const seen: Array<AcpSessionSnapshot | null> = [];
	const stop = subscribeAcpSnapshot(api, "a", (next) => seen.push(next));
	api.push(snapshot("a", "latest"));
	api.read("a", null);
	await Promise.resolve();
	expect(seen).toEqual([snapshot("a", "latest")]);
	stop();
});

test("initial reads load idle history and report closed sessions", async () => {
	const api = source();
	const seen: Array<AcpSessionSnapshot | null> = [];
	const stopA = subscribeAcpSnapshot(api, "a", (next) => seen.push(next));
	const stopB = subscribeAcpSnapshot(api, "b", (next) => seen.push(next));
	api.read("a", snapshot("a", "history"));
	api.read("b", null);
	await Promise.resolve();
	expect(seen).toEqual([snapshot("a", "history"), null]);
	stopA(); stopB();
});

test("subscribes before requesting a snapshot so synchronous updates are retained", async () => {
	const api = source();
	const seen: Array<AcpSessionSnapshot | null> = [];
	const stop = subscribeAcpSnapshot({
		onAcpSnapshot: api.onAcpSnapshot,
		acpSnapshot: async (id) => {
			api.push(snapshot(id, "latest"));
			return snapshot(id, "stale");
		},
	}, "a", (next) => seen.push(next));
	await Promise.resolve();
	expect(seen).toEqual([snapshot("a", "latest")]);
	stop();
});
