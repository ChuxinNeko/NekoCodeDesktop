import { Preferences } from "@capacitor/preferences";
import type { AgentDefaults, AgentSnapshot, SendPromptResult } from "../../src/shared/agent";
import { applySnapshotDelta, type AgentSnapshotDelta } from "../../src/shared/agent-delta";
import type { LanState, LanTaskOptions } from "../../src/shared/lan";
import type { RelayDeviceSummary } from "../../src/shared/relay";
import type { WorkflowAnswer } from "../../src/shared/workflow";
import type { SlashCommandSummary } from "../../src/shared/commands";
import { account, AccountClient } from "./account-client";
import { lan, LanClient, LanError, type SubmitResult } from "./lan-client";
import { relay, RelayClient } from "./relay-client";
import type { PreferencesLike } from "./relay-identity";

export type TransportMode = "lan" | "relay";

const MODE_KEY = "desktop-transport";
export const RELAY_ENDPOINT_LABEL = "公网中继";

/** What a client tells the desktop about the transcript window it already has. */
export interface DeltaRequest {
	/** The version this client last received; omitted asks for the whole window. */
	since?: string;
	/** Earliest cell the client holds, so the window does not slide out from it. */
	from?: string;
	/** Extend the window this many cells further back. */
	back?: number;
}

/** Cells one "load earlier" reaches back; mirrors the desktop's own step. */
export const EARLIER_STEP = 60;

/** One slice of a tool result the transcript only carries the head of. */
export interface ToolOutputChunk {
	text: string;
	offset: number;
	/** Length of the whole result, so the caller knows what is still missing. */
	total: number;
}

export interface SyncedSnapshot {
	snapshot: AgentSnapshot;
	/** Older turns exist before this transcript's first cell. */
	more: boolean;
}

interface ActiveClient {
	binding: unknown;
	state(): Promise<LanState>;
	defaults(projectId: string): Promise<AgentDefaults>;
	snapshot(id: string): Promise<AgentSnapshot>;
	delta(id: string, options?: DeltaRequest): Promise<AgentSnapshotDelta>;
	toolOutput(id: string, toolCallId: string, offset: number): Promise<ToolOutputChunk>;
	create(projectId: string, text: string, options: LanTaskOptions): Promise<SubmitResult>;
	send(id: string, text: string): Promise<SendPromptResult>;
	configure(id: string, options: LanTaskOptions): Promise<AgentSnapshot>;
	abort(id: string): Promise<AgentSnapshot>;
	answer(id: string, answer: WorkflowAnswer): Promise<AgentSnapshot>;
	cancelWorker(id: string, workerId: string): Promise<AgentSnapshot>;
	commands(id: string): Promise<SlashCommandSummary[]>;
}

export class DesktopClient {
	constructor(
		private readonly lanClient: LanClient = lan,
		private readonly relayClient: RelayClient = relay,
		private readonly preferences: PreferencesLike = Preferences,
		private readonly accountClient: Pick<AccountClient, "restore"> = account,
	) {}

	mode: TransportMode | null = null;

	/** The transcript {@link syncSnapshot} holds, and the version it is current as of. */
	private sync: { id: string; version: string; snapshot: AgentSnapshot; more: boolean } | null = null;
	/** Serializes pulls; see {@link pull}. */
	private queue: Promise<unknown> = Promise.resolve();

	get binding(): { name: string; endpoint: string } | null {
		if (this.mode === "lan" && this.lanClient.binding) {
			return { name: this.lanClient.binding.name, endpoint: this.lanClient.binding.endpoint };
		}
		if (this.mode === "relay" && this.relayClient.binding) {
			return { name: this.relayClient.binding.desktop.name, endpoint: RELAY_ENDPOINT_LABEL };
		}
		return null;
	}

	get marker(): object | null {
		if (this.mode === "lan") return this.lanClient.binding;
		if (this.mode === "relay") return this.relayClient.binding;
		return null;
	}

	get hasLan(): boolean {
		return this.lanClient.binding !== null;
	}

	get hasRelay(): boolean {
		return this.relayClient.binding !== null;
	}

	get lanEndpoint(): string {
		return this.lanClient.binding?.endpoint ?? "";
	}

	get activeRelayDeviceId(): string | null {
		return this.mode === "relay" ? (this.relayClient.binding?.desktop.id ?? null) : null;
	}

	private active(): ActiveClient {
		if (this.mode === "lan" && this.lanClient.binding) return this.lanClient;
		if (this.mode === "relay" && this.relayClient.binding) return this.relayClient;
		throw new LanError("请先绑定电脑", 401);
	}

	async restore(): Promise<boolean> {
		this.sync = null;
		await this.accountClient.restore();
		const [lanBinding, relayBinding] = await Promise.all([this.lanClient.restore(), this.relayClient.restore()]);
		let preferred: TransportMode | null = null;
		try {
			const saved = (await this.preferences.get({ key: MODE_KEY })).value;
			preferred = saved === "lan" || saved === "relay" ? saved : null;
		} catch {
			preferred = null;
		}
		if (preferred === "lan" && lanBinding) this.mode = "lan";
		else if (preferred === "relay" && relayBinding) this.mode = "relay";
		else if (lanBinding) this.mode = "lan";
		else if (relayBinding) this.mode = "relay";
		else this.mode = null;
		if (this.mode !== "relay") await this.relayClient.disconnect();
		return this.mode !== null;
	}

	async pairLan(endpoint: string, code: string, name: string): Promise<void> {
		this.sync = null;
		await this.lanClient.pair(endpoint, code, name);
		await this.relayClient.disconnect();
		this.mode = "lan";
		await this.preferences.set({ key: MODE_KEY, value: "lan" });
	}

	async selectRelay(device: RelayDeviceSummary): Promise<void> {
		this.sync = null;
		await this.relayClient.select(device);
		this.mode = "relay";
		await this.preferences.set({ key: MODE_KEY, value: "relay" });
	}

	async switch(mode: TransportMode): Promise<void> {
		this.sync = null;
		if (mode === "lan") {
			if (!this.lanClient.binding) throw new LanError("没有可用的局域网绑定", 401);
			await this.relayClient.disconnect();
		} else {
			if (!this.relayClient.binding) throw new LanError("没有可用的公网连接", 401);
		}
		this.mode = mode;
		await this.preferences.set({ key: MODE_KEY, value: mode });
	}

	async disconnect(): Promise<void> {
		this.sync = null;
		if (this.mode === "lan") await this.lanClient.disconnect();
		else if (this.mode === "relay") await this.relayClient.forget();
		this.mode = this.lanClient.binding ? "lan" : this.relayClient.binding ? "relay" : null;
		if (this.mode) await this.preferences.set({ key: MODE_KEY, value: this.mode });
		else await this.preferences.remove({ key: MODE_KEY });
	}

	async suspend(): Promise<void> {
		if (this.mode === "relay") await this.relayClient.disconnect();
	}

	async deactivate(): Promise<void> {
		this.sync = null;
		if (this.mode === "relay") await this.relayClient.disconnect();
		this.mode = null;
		await this.preferences.remove({ key: MODE_KEY });
	}

	state() {
		return this.active().state();
	}
	defaults(projectId: string) {
		return this.active().defaults(projectId);
	}
	snapshot(id: string) {
		return this.active().snapshot(id);
	}

	/**
	 * The snapshot for `id`, fetched as a diff against whatever this client
	 * already holds.
	 *
	 * A transcript carries every tool output it ever produced, so refetching it
	 * whole on each poll makes a long session cost hundreds of times what a new
	 * one does — over the relay that is the difference between usable and not.
	 * Here a poll costs only the cells that actually changed.
	 */
	syncSnapshot(id: string): Promise<SyncedSnapshot> {
		return this.pull(id, 0);
	}

	/**
	 * Widen the held window by another page of older turns.
	 *
	 * The first look at a session only brings its tail, so a thousand-turn
	 * transcript opens as fast as a new one; this is how the rest of it is
	 * reached, a page at a time and only when asked for.
	 */
	loadEarlier(id: string): Promise<SyncedSnapshot> {
		return this.pull(id, EARLIER_STEP);
	}

	/**
	 * Run one pull at a time.
	 *
	 * `since`, `from` and the base a diff is applied to all have to describe the
	 * same held snapshot. Overlapping pulls read that state before the other has
	 * written it, so a poll that started during a lazy load would carry the old
	 * window and hand back the narrow one — undoing the history the user just
	 * scrolled up to. Queueing is free here: pulls are one round trip and polls
	 * are seconds apart.
	 */
	private pull(id: string, back: number): Promise<SyncedSnapshot> {
		const run = this.queue.then(
			() => this.fetch(id, back),
			() => this.fetch(id, back),
		);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async fetch(id: string, back: number): Promise<SyncedSnapshot> {
		const client = this.active();
		const held = this.sync?.id === id ? this.sync : null;
		const delta = await client.delta(id, {
			since: held?.version,
			from: held?.snapshot.cells[0]?.id,
			...(back > 0 ? { back } : {}),
		});
		const next = applySnapshotDelta(held?.snapshot ?? null, delta);
		if (next) return this.hold({ id, version: delta.version, snapshot: next, more: delta.more === true });
		// The desktop diffed against something we do not have. Asking with neither
		// a cursor nor a window always comes back whole — the one way out of a
		// desync, at the cost of dropping back to the tail.
		const whole = await client.delta(id);
		const restored = applySnapshotDelta(null, whole);
		if (!restored) throw new LanError("会话同步失败，请重新打开任务");
		return this.hold({ id, version: whole.version, snapshot: restored, more: whole.more === true });
	}

	private hold(sync: NonNullable<DesktopClient["sync"]>): SyncedSnapshot {
		this.sync = sync;
		return { snapshot: sync.snapshot, more: sync.more };
	}

	/** The rest of a tool result, from `offset` on. */
	toolOutput(id: string, toolCallId: string, offset: number): Promise<ToolOutputChunk> {
		return this.active().toolOutput(id, toolCallId, offset);
	}

	/** Drop the held transcript, so the next sync starts from a full snapshot. */
	forgetSync(): void {
		this.sync = null;
	}

	create(projectId: string, text: string, options: LanTaskOptions) {
		return this.active().create(projectId, text, options);
	}
	send(id: string, text: string) {
		return this.active().send(id, text);
	}
	configure(id: string, options: LanTaskOptions) {
		return this.active().configure(id, options);
	}
	abort(id: string) {
		return this.active().abort(id);
	}
	answer(id: string, answer: WorkflowAnswer) {
		return this.active().answer(id, answer);
	}
	cancelWorker(id: string, workerId: string) {
		return this.active().cancelWorker(id, workerId);
	}
	commands(id: string) {
		return this.active().commands(id);
	}
}

export const desktop = new DesktopClient();
