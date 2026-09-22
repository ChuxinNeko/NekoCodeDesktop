import type { AgentCell, AgentSnapshot, ModelOption } from "./agent";
import type { CheckpointSummary } from "./checkpoints";

/**
 * A snapshot minus the three lists worth tracking separately. Everything left
 * is small enough to resend whole on every delta, so it needs no diffing.
 */
export type AgentSnapshotRest = Omit<AgentSnapshot, "cells" | "models" | "checkpoints">;

/**
 * A snapshot expressed as what changed since the one the client already holds.
 *
 * `version` is the token the client echoes back as `since` next time. A server
 * that no longer remembers that token answers with `full` instead of a diff, so
 * a client that fell behind — or reconnected to a restarted desktop — recovers
 * without a separate handshake. An absent field means unchanged.
 */
export interface AgentSnapshotDelta {
	version: string;
	/**
	 * Cells exist before the window this delta describes. The transcript a remote
	 * client holds is a tail of the real one, so "the first cell" is not the same
	 * question as "the start of the session".
	 */
	more?: boolean;
	/** Replaces everything. Sent when the server cannot diff against `since`. */
	full?: AgentSnapshot;
	/** Cells that are new, or whose content changed. */
	cells?: AgentCell[];
	/** The complete id order, sent only when cells were added, dropped or moved. */
	order?: string[];
	models?: ModelOption[];
	checkpoints?: CheckpointSummary[];
	rest?: AgentSnapshotRest;
}

/** What the server remembers about a snapshot it has already sent. */
export interface SnapshotFingerprint {
	/** Cell id to content hash, in transcript order. */
	cells: Map<string, string>;
	models: string;
	checkpoints: string;
}

/**
 * A content hash for change detection only — never for authentication.
 *
 * Two FNV-1a passes with different offsets and multipliers, so a change has to
 * collide in both halves at once to go unnoticed. At transcript scale that is
 * far below the rate at which the connection itself drops frames.
 */
function hash(value: unknown): string {
	const text = JSON.stringify(value) ?? "null";
	let a = 0x811c9dc5;
	let b = 0xc59d1c81;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b ^ code, 0x85ebca6b);
	}
	return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

function restOf(snapshot: AgentSnapshot): AgentSnapshotRest {
	const { cells: _cells, models: _models, checkpoints: _checkpoints, ...rest } = snapshot;
	return rest;
}

function sameOrder(previous: Map<string, string>, next: Map<string, string>): boolean {
	if (previous.size !== next.size) return false;
	const ids = next.keys();
	for (const id of previous.keys()) {
		if (ids.next().value !== id) return false;
	}
	return true;
}

export function fingerprintSnapshot(snapshot: AgentSnapshot): SnapshotFingerprint {
	const cells = new Map<string, string>();
	for (const cell of snapshot.cells) cells.set(cell.id, hash(cell));
	return { cells, models: hash(snapshot.models), checkpoints: hash(snapshot.checkpoints) };
}

/**
 * Cut `snapshot` down to what `previous` does not already have. Falls back to a
 * full snapshot whenever a diff cannot be trusted, which is always correct and
 * only ever costs bandwidth.
 */
export function diffSnapshot(
	snapshot: AgentSnapshot,
	next: SnapshotFingerprint,
	previous: SnapshotFingerprint | undefined,
	version: string,
): AgentSnapshotDelta {
	// A duplicate cell id collapses in the fingerprint map, which would drop a
	// cell from `order`. The transcript should never produce one — but a full
	// snapshot costs bandwidth, while a silently missing cell costs correctness.
	if (!previous || next.cells.size !== snapshot.cells.length) return { version, full: snapshot };
	const delta: AgentSnapshotDelta = { version, rest: restOf(snapshot) };
	const cells = snapshot.cells.filter((cell) => previous.cells.get(cell.id) !== next.cells.get(cell.id));
	if (cells.length) delta.cells = cells;
	if (!sameOrder(previous.cells, next.cells)) delta.order = [...next.cells.keys()];
	if (previous.models !== next.models) delta.models = snapshot.models;
	if (previous.checkpoints !== next.checkpoints) delta.checkpoints = snapshot.checkpoints;
	return delta;
}

/**
 * Rebuild the current snapshot from the one the client holds plus `delta`.
 *
 * Returns null when the delta cannot be applied — the caller's cue to ask for a
 * full snapshot rather than render something half-stitched.
 */
export function applySnapshotDelta(
	base: AgentSnapshot | null,
	delta: AgentSnapshotDelta,
): AgentSnapshot | null {
	if (delta.full) return delta.full;
	if (!base) return null;
	const byId = new Map(base.cells.map((cell) => [cell.id, cell]));
	for (const cell of delta.cells ?? []) byId.set(cell.id, cell);
	let cells: AgentCell[];
	if (delta.order) {
		cells = [];
		for (const id of delta.order) {
			const cell = byId.get(id);
			// The delta was cut against a snapshot this client never held.
			if (!cell) return null;
			cells.push(cell);
		}
	} else {
		cells = base.cells.map((cell) => byId.get(cell.id) ?? cell);
	}
	const { cells: _cells, models, checkpoints, ...rest } = base;
	return {
		...(delta.rest ?? rest),
		cells,
		models: delta.models ?? models,
		checkpoints: delta.checkpoints ?? checkpoints,
	};
}

/** How many past versions stay diffable before a client is sent a full snapshot. */
const HISTORY = 12;

/**
 * Remembers the fingerprints of recently sent snapshots so a client can ask
 * "what changed since <version>".
 *
 * Bounded on purpose: each poll mints a version, so without eviction a client
 * that stays open all day would pin every transcript it ever saw. Past
 * {@link HISTORY} the oldest is dropped and whoever still holds it gets a full
 * snapshot — which is the same recovery path as a restarted desktop.
 */
export class SnapshotDeltaCache {
	private readonly sent = new Map<string, SnapshotFingerprint>();
	private sequence = 0;

	/** `nonce` scopes the tokens, so versions from a past session never match. */
	constructor(private readonly nonce: string) {}

	next(snapshot: AgentSnapshot, since?: string): AgentSnapshotDelta {
		const previous = since ? this.sent.get(since) : undefined;
		const fingerprint = fingerprintSnapshot(snapshot);
		const version = `${this.nonce}.${++this.sequence}`;
		this.sent.set(version, fingerprint);
		while (this.sent.size > HISTORY) {
			const oldest = this.sent.keys().next().value;
			if (oldest === undefined) break;
			this.sent.delete(oldest);
		}
		return diffSnapshot(snapshot, fingerprint, previous, version);
	}
}
