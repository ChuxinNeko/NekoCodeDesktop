import { expect, test } from "bun:test";
import type { AgentCell, AgentSnapshot } from "../../src/shared/agent";
import { SnapshotDeltaCache, type AgentSnapshotDelta } from "../../src/shared/agent-delta";
import { remoteView } from "../../src/main/agent-remote-view";
import type { DeltaRequest } from "./desktop-client";
import type { RelayDeviceSummary } from "../../src/shared/relay";
import { DesktopClient } from "./desktop-client";
import type { LanClient } from "./lan-client";
import type { RelayClient } from "./relay-client";
import type { PreferencesLike } from "./relay-identity";

function fakePreferences(initial: Record<string, string> = {}) {
	const data = new Map<string, string>(Object.entries(initial));
	const prefs: PreferencesLike & { data: Map<string, string> } = {
		data,
		get: async ({ key }) => ({ value: data.get(key) ?? null }),
		set: async ({ key, value }) => { data.set(key, value); },
		remove: async ({ key }) => { data.delete(key); },
	};
	return prefs;
}

/**
 * A desktop's side of the delta protocol, backed by the real cache so the test
 * exercises the wire contract rather than a stand-in for it.
 */
function fakeTranscript(count = 1) {
	const cache = new SnapshotDeltaCache("fake");
	const cells: AgentCell[] = Array.from({ length: count }, (_, i) => (
		{ id: `c${String(i + 1)}`, type: "user", text: `m${String(i + 1)}`, timestamp: i }
	));
	const requests: DeltaRequest[] = [];
	let unstitchable = false;
	const snapshot = () => ({
		session: { id: "task-1", sessionFile: undefined, cwd: "/tmp", title: "t" },
		cells: [...cells], models: [], checkpoints: [],
	}) as unknown as AgentSnapshot;
	return {
		requests,
		/** Every `since` the client has sent, in order — undefined means "send it all". */
		get since(): Array<string | undefined> { return requests.map((request) => request.since); },
		append(cell: AgentCell) { cells.push(cell); },
		/** Answer the next request with a delta that names a cell nobody holds. */
		breakOnce() { unstitchable = true; },
		delta(_id: string, options: DeltaRequest = {}): Promise<AgentSnapshotDelta> {
			requests.push(options);
			if (unstitchable) {
				unstitchable = false;
				return Promise.resolve({ version: "bogus", order: ["ghost"] });
			}
			// The desktop's own windowing, so the fake cannot drift from the server.
			const view = remoteView(snapshot(), options);
			return Promise.resolve({ ...cache.next(view.snapshot, options.since), more: view.more });
		},
	};
}

function fakeLan(transcript = fakeTranscript()) {
	const calls: string[] = [];
	const client = {
		binding: null as { endpoint: string; token: string; name: string } | null,
		calls,
		transcript,
		delta: (id: string, options?: DeltaRequest) => transcript.delta(id, options),
		async restore() {
			calls.push("lan.restore");
			return this.binding;
		},
		async pair(endpoint: string) {
			calls.push("lan.pair");
			this.binding = { endpoint, token: "a".repeat(64), name: "LAN Desktop" };
		},
		async disconnect() {
			calls.push("lan.disconnect");
			this.binding = null;
		},
		async state() {
			calls.push("lan.state");
			return { tasks: [], projects: [] };
		},
	};
	return client as typeof client & LanClient;
}

function fakeRelay() {
	const calls: string[] = [];
	const client = {
		binding: null as { accountEmail: string; desktop: { id: string; name: string; publicKey: string } } | null,
		calls,
		async restore() {
			calls.push("relay.restore");
			return this.binding;
		},
		async select(device: RelayDeviceSummary) {
			calls.push("relay.select");
			this.binding = { accountEmail: "neko@example.com", desktop: { id: device.id, name: device.name, publicKey: device.publicKey } };
		},
		async disconnect() {
			calls.push("relay.disconnect");
		},
		async forget() {
			calls.push("relay.forget");
			this.binding = null;
		},
		async state() {
			calls.push("relay.state");
			return { tasks: [], projects: [] };
		},
	};
	return client as typeof client & RelayClient;
}

const DEVICE: RelayDeviceSummary = { id: "a".repeat(64), name: "Relay Desktop", publicKey: "key", lastSeenAt: new Date().toISOString(), online: true };

function setup(preferred?: string, cells?: number) {
	const preferences = fakePreferences(preferred ? { "desktop-transport": preferred } : {});
	const lanClient = fakeLan(fakeTranscript(cells));
	const relayClient = fakeRelay();
	const accountClient = { restore: async () => false };
	const desktop = new DesktopClient(lanClient, relayClient, preferences, accountClient);
	return { desktop, preferences, lanClient, relayClient };
}

test("a LAN-only binding restores and serves without any public sign-in", async () => {
	const { desktop, lanClient, relayClient } = setup();
	lanClient.binding = { endpoint: "http://192.168.1.8:47832", token: "a".repeat(64), name: "LAN Desktop" };
	expect(await desktop.restore()).toBe(true);
	expect(desktop.mode).toBe("lan");
	expect(await desktop.state()).toEqual({ tasks: [], projects: [] });
	expect(lanClient.calls).toContain("lan.state");
});

test("a relay-only binding restores and serves without any LAN binding", async () => {
	const { desktop, relayClient } = setup();
	relayClient.binding = { accountEmail: "neko@example.com", desktop: { id: DEVICE.id, name: "Relay Desktop", publicKey: "key" } };
	expect(await desktop.restore()).toBe(true);
	expect(desktop.mode).toBe("relay");
	expect(await desktop.state()).toEqual({ tasks: [], projects: [] });
	expect(relayClient.calls).toContain("relay.state");
});

test("the preferred mode wins and switching keeps both bindings", async () => {
	const { desktop, lanClient, relayClient, preferences } = setup("relay");
	lanClient.binding = { endpoint: "http://192.168.1.8:47832", token: "a".repeat(64), name: "LAN Desktop" };
	relayClient.binding = { accountEmail: "neko@example.com", desktop: { id: DEVICE.id, name: "Relay Desktop", publicKey: "key" } };
	await desktop.restore();
	expect(desktop.mode).toBe("relay");

	await desktop.switch("lan");
	expect(desktop.mode).toBe("lan");
	expect(preferences.data.get("desktop-transport")).toBe("lan");
	expect(desktop.hasLan).toBe(true);
	expect(desktop.hasRelay).toBe(true);
	expect(relayClient.calls).toContain("relay.disconnect");
	expect(relayClient.binding).not.toBeNull();
});

test("pairLan and selectRelay never touch the other mode's binding", async () => {
	const { desktop, lanClient, relayClient } = setup();
	await desktop.pairLan("http://192.168.1.8:47832", "123456", "手机");
	expect(desktop.mode).toBe("lan");
	expect(relayClient.binding).toBeNull();

	await desktop.selectRelay(DEVICE);
	expect(desktop.mode).toBe("relay");
	expect(lanClient.binding).not.toBeNull();
	expect(relayClient.binding?.desktop.id).toBe(DEVICE.id);
});

test("disconnect removes only the current binding and falls back to the other", async () => {
	const { desktop, lanClient, relayClient, preferences } = setup();
	await desktop.pairLan("http://192.168.1.8:47832", "123456", "手机");
	await desktop.selectRelay(DEVICE);
	expect(desktop.mode).toBe("relay");

	await desktop.disconnect();
	expect(relayClient.calls).toContain("relay.forget");
	expect(lanClient.calls).not.toContain("lan.disconnect");
	expect(desktop.mode).toBe("lan");
	expect(preferences.data.get("desktop-transport")).toBe("lan");

	await desktop.disconnect();
	expect(lanClient.calls).toContain("lan.disconnect");
	expect(desktop.mode).toBeNull();
	expect(preferences.data.has("desktop-transport")).toBe(false);
});

test("deactivate stops the active mode without deleting any binding", async () => {
	const { desktop, relayClient, preferences } = setup();
	await desktop.selectRelay(DEVICE);
	expect(preferences.data.get("desktop-transport")).toBe("relay");

	await desktop.deactivate();
	expect(relayClient.calls).toContain("relay.disconnect");
	expect(relayClient.calls).not.toContain("relay.forget");
	expect(relayClient.binding).not.toBeNull();
	expect(desktop.mode).toBeNull();
	expect(desktop.marker).toBeNull();
	expect(desktop.hasRelay).toBe(true);
	expect(preferences.data.has("desktop-transport")).toBe(false);

	await desktop.switch("relay");
	expect(desktop.mode).toBe("relay");
	expect(await desktop.state()).toEqual({ tasks: [], projects: [] });
});

test("suspend closes the relay socket but keeps the binding, and never touches LAN", async () => {
	const { desktop, lanClient, relayClient } = setup();
	await desktop.selectRelay(DEVICE);
	await desktop.suspend();
	expect(relayClient.calls).toContain("relay.disconnect");
	expect(relayClient.calls).not.toContain("relay.forget");
	expect(relayClient.binding).not.toBeNull();
	expect(desktop.mode).toBe("relay");

	const lanOnly = setup();
	await lanOnly.desktop.pairLan("http://192.168.1.8:47832", "123456", "手机");
	const relayDisconnects = () => lanOnly.relayClient.calls.filter((call) => call === "relay.disconnect").length;
	const before = relayDisconnects();
	await lanOnly.desktop.suspend();
	expect(lanOnly.lanClient.calls).not.toContain("lan.disconnect");
	expect(relayDisconnects()).toBe(before);
});

test("syncSnapshot pulls the transcript once, then only what changed", async () => {
	const { desktop, lanClient } = setup();
	lanClient.binding = { endpoint: "http://192.168.1.8:47832", token: "a".repeat(64), name: "LAN Desktop" };
	await desktop.restore();

	const first = await desktop.syncSnapshot("task-1");
	expect(first.snapshot.cells.map((cell) => cell.id)).toEqual(["c1"]);
	// Nothing held yet, so the first ask carries no cursor.
	expect(lanClient.transcript.since).toEqual([undefined]);

	lanClient.transcript.append({ id: "c2", type: "user", text: "again", timestamp: 2 });
	const second = await desktop.syncSnapshot("task-1");
	expect(second.snapshot.cells.map((cell) => cell.id)).toEqual(["c1", "c2"]);
	expect(lanClient.transcript.since[1]).toBeDefined();
});

test("syncSnapshot refetches in full when a delta cannot be stitched on", async () => {
	const { desktop, lanClient } = setup();
	lanClient.binding = { endpoint: "http://192.168.1.8:47832", token: "a".repeat(64), name: "LAN Desktop" };
	await desktop.restore();
	await desktop.syncSnapshot("task-1");

	lanClient.transcript.breakOnce();
	const recovered = await desktop.syncSnapshot("task-1");
	expect(recovered.snapshot.cells.map((cell) => cell.id)).toEqual(["c1"]);
	// The bad delta was retried without a cursor, which always comes back whole.
	expect(lanClient.transcript.since).toEqual([undefined, expect.any(String), undefined]);
});

test("a different task, a dropped sync and a transport switch all start over", async () => {
	const { desktop, lanClient } = setup();
	lanClient.binding = { endpoint: "http://192.168.1.8:47832", token: "a".repeat(64), name: "LAN Desktop" };
	await desktop.restore();

	await desktop.syncSnapshot("task-1");
	await desktop.syncSnapshot("other-task");
	expect(lanClient.transcript.since).toEqual([undefined, undefined]);

	await desktop.syncSnapshot("other-task");
	expect(lanClient.transcript.since[2]).toBeDefined();

	desktop.forgetSync();
	await desktop.syncSnapshot("other-task");
	expect(lanClient.transcript.since[3]).toBeUndefined();
});

test("a long transcript arrives as its tail, and older turns load a page at a time", async () => {
	const { desktop, lanClient } = setup(undefined, 150);
	lanClient.binding = { endpoint: "http://192.168.1.8:47832", token: "a".repeat(64), name: "LAN Desktop" };
	await desktop.restore();

	// The first look costs a window, not the whole session.
	const first = await desktop.syncSnapshot("task-1");
	expect(first.snapshot.cells).toHaveLength(60);
	expect(first.snapshot.cells[0].id).toBe("c91");
	expect(first.more).toBe(true);

	const wider = await desktop.loadEarlier("task-1");
	expect(wider.snapshot.cells).toHaveLength(120);
	expect(wider.snapshot.cells[0].id).toBe("c31");
	expect(wider.more).toBe(true);

	const all = await desktop.loadEarlier("task-1");
	expect(all.snapshot.cells).toHaveLength(150);
	expect(all.snapshot.cells[0].id).toBe("c1");
	expect(all.more).toBe(false);

	// A poll must not slide the window back off what the user already scrolled to.
	lanClient.transcript.append({ id: "c151", type: "user", text: "新消息", timestamp: 151 });
	const poll = await desktop.syncSnapshot("task-1");
	expect(poll.snapshot.cells).toHaveLength(151);
	expect(poll.snapshot.cells[0].id).toBe("c1");
	expect(poll.more).toBe(false);
	// And it stayed a diff: only the appended cell crossed the wire.
	expect(lanClient.transcript.requests[3].since).toBeDefined();
});

test("a poll overlapping a lazy load never narrows the window back", async () => {
	const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	const { desktop, lanClient } = setup(undefined, 150);
	lanClient.binding = { endpoint: "http://192.168.1.8:47832", token: "a".repeat(64), name: "LAN Desktop" };
	await desktop.restore();
	await desktop.syncSnapshot("task-1");

	// Hold every response open, so the two land in the worst possible order.
	const release: Array<() => void> = [];
	const answer = lanClient.delta;
	lanClient.delta = (id: string, options?: DeltaRequest) =>
		new Promise((resolve) => release.push(() => { resolve(answer(id, options)); }));

	const earlier = desktop.loadEarlier("task-1");
	const poll = desktop.syncSnapshot("task-1");
	await tick();
	// Serialized: the poll is not issued at all while the load is in flight, so
	// it cannot be holding the window from before it.
	expect(release).toHaveLength(1);

	release[0]();
	expect(await earlier).toMatchObject({ more: true });
	await tick();
	expect(release).toHaveLength(2);
	release[1]();

	const polled = await poll;
	expect(polled.snapshot.cells).toHaveLength(120);
	expect(polled.snapshot.cells[0].id).toBe("c31");
});
