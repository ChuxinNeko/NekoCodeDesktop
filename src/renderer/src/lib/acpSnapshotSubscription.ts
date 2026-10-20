import type { AcpSessionSnapshot } from "../../../shared/acp";

interface SnapshotSource {
	acpSnapshot(id: string): Promise<AcpSessionSnapshot | null>;
	onAcpSnapshot(listener: (snapshot: AcpSessionSnapshot) => void): () => void;
}

/** A delayed initial read must never replace a newer streamed snapshot. */
export function subscribeAcpSnapshot(
	source: SnapshotSource,
	id: string,
	apply: (snapshot: AcpSessionSnapshot | null) => void,
): () => void {
	let cancelled = false;
	let pushed = false;
	const unsubscribe = source.onAcpSnapshot((next) => {
		if (cancelled || next.id !== id) return;
		pushed = true;
		apply(next);
	});
	void source.acpSnapshot(id).then((next) => {
		if (cancelled || pushed || (next && next.id !== id)) return;
		apply(next);
	}).catch(() => undefined);
	return () => {
		cancelled = true;
		unsubscribe();
	};
}
