import { useEffect, useRef, useState } from "react";
import type { SendPromptRequest } from "../../../../shared/agent";

export interface QueuedPrompt {
	id: number;
	request: SendPromptRequest;
}

export interface ComposerQueueState {
	scope: string;
	items: QueuedPrompt[];
}

export const emptyComposerQueue = (scope: string): ComposerQueueState => ({ scope, items: [] });

export function enqueueComposerPrompt(
	state: ComposerQueueState,
	scope: string,
	id: number,
	request: SendPromptRequest,
): ComposerQueueState {
	const items = state.scope === scope ? state.items : [];
	return { scope, items: [...items, { id, request }] };
}

export function removeComposerPrompt(state: ComposerQueueState, scope: string, id: number): ComposerQueueState {
	if (state.scope !== scope) return emptyComposerQueue(scope);
	return { scope, items: state.items.filter((item) => item.id !== id) };
}

export function queuedPromptAfterTransition(
	wasBlocked: boolean,
	blocked: boolean,
	items: readonly QueuedPrompt[],
): QueuedPrompt | null {
	return wasBlocked && !blocked ? items[0] ?? null : null;
}

/** Keeps pending messages attached to the current workflow until it settles. */
export function useComposerQueue({ scope, disabled, streaming, onSend, onSteer }: {
	scope: string;
	disabled: boolean;
	streaming: boolean;
	onSend: (request: SendPromptRequest) => void | Promise<void>;
	onSteer?: (request: SendPromptRequest) => void | Promise<void>;
}) {
	const [state, setState] = useState<ComposerQueueState>(() => emptyComposerQueue(scope));
	const [sendingId, setSendingId] = useState<number | null>(null);
	const [error, setError] = useState("");
	const nextId = useRef(1);
	const items = state.scope === scope ? state.items : [];
	const current = useRef({ scope, items, onSend, onSteer, disabled, streaming });
	current.current = { scope, items, onSend, onSteer, disabled, streaming };
	const inFlight = useRef<number | null>(null);
	const previous = useRef({ scope, blocked: disabled || streaming });
	useEffect(() => setError(""), [scope]);

	const dispatch = async (item: QueuedPrompt, steer: boolean) => {
		if (inFlight.current !== null) return;
		const target = current.current;
		const send = steer ? target.onSteer : target.onSend;
		if (!send || target.disabled) return;
		inFlight.current = item.id;
		setSendingId(item.id);
		setError("");
		try {
			await send(item.request);
			setState((value) => value.scope === target.scope ? removeComposerPrompt(value, target.scope, item.id) : value);
		} catch (cause) {
			if (current.current.scope === target.scope) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			inFlight.current = null;
			setSendingId(null);
		}
	};

	useEffect(() => {
		const blocked = disabled || streaming;
		// If a steer is being accepted as the run ends, keep the transition
		// pending until it settles so the remaining rows are still sent.
		if (previous.current.scope === scope && previous.current.blocked && !blocked && inFlight.current !== null) return;
		const next = previous.current.scope === scope
			? queuedPromptAfterTransition(previous.current.blocked, blocked, current.current.items) : null;
		previous.current = { scope, blocked };
		if (next) void dispatch(next, false);
	}, [disabled, streaming, scope, sendingId]);

	const enqueue = (request: SendPromptRequest) => {
		const id = nextId.current++;
		setState((value) => enqueueComposerPrompt(value, scope, id, request));
	};
	const remove = (id: number) => {
		if (inFlight.current === id) return;
		setState((value) => removeComposerPrompt(value, scope, id));
	};
	const sendNow = (id: number) => {
		const target = current.current;
		const item = target.items.find((entry) => entry.id === id);
		if (item) void dispatch(item, target.streaming);
	};
	return { items, enqueue, remove, sendNow, sendingId, error };
}
