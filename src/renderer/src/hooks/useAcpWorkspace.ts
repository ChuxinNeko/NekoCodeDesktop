import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PromptImageAttachment, SessionSummary } from "../../../shared/agent";
import {
	NEKO_LOCAL_WORKSPACE,
	type AcpAgentInfo,
	type AcpHistory,
	type AcpSessionSnapshot,
	type AcpState,
} from "../../../shared/acp";
import { acpAgentsRows, acpRowKey, type AcpAgentRowTarget } from "../../../shared/acp-sessions";
import { api, errorMessage } from "../api";
import { subscribeAcpSnapshot } from "../lib/acpSnapshotSubscription";

const HISTORY_CHANGED_DEBOUNCE_MS = 400;

const warmKey = (agentId: string, cwd: string) => JSON.stringify([agentId, cwd]);

export interface AcpWorkspace {
	/** Every configured agent, enabled or not. */
	agents: AcpAgentInfo[];
	/** The agent the current workspace is, or null in NekoLocal. */
	agent: AcpAgentInfo | null;
	/** Every enabled agent's conversations, for the sidebar they share with NekoLocal. */
	rows: SessionSummary[];
	loading: boolean;
	/** The selected agent could not list its history; open conversations still show. */
	historyError: string | null;
	snapshot: AcpSessionSnapshot | null;
	activeRowId: string | null;
	error: string | null;
	dismissError: () => void;
	/**
	 * Make a row of any agent that agent's open conversation. Resolves to the
	 * agent's id once it is, or null when it could not be opened — the caller
	 * switches the workspace to it.
	 */
	open: (row: Pick<SessionSummary, "id">) => Promise<string | null>;
	/** The open session behind a row, if it is open. */
	liveId: (rowId: string) => string | null;
	/** Open a row's conversation without selecting it — for a pane beside the selection. */
	ensureLive: (rowId: string) => Promise<string | null>;
	/** Leave the open conversation for an empty composer, as "new session" does. */
	startNew: () => void;
	send: (cwd: string, text: string, images?: PromptImageAttachment[]) => Promise<void>;
	cancel: () => void;
	setConfig: (configId: string, value: string) => void;
	respondPermission: (requestId: string, optionId: string | null) => void;
	refreshHistory: () => void;
}

/**
 * The ACP side of the workspace: every enabled agent's conversations for the
 * sidebar, which agent is selected, and the conversation on screen.
 *
 * Each agent remembers its own open conversation, so switching workspaces and
 * back returns to where that agent was left.
 */
export function useAcpWorkspace(workspace: string, cwd: string | null): AcpWorkspace {
	const available = api.runtime !== "web";
	const [state, setState] = useState<AcpState>({ agents: [], sessions: [] });
	const [histories, setHistories] = useState<Record<string, AcpHistory>>({});
	const [pendingLoads, setPendingLoads] = useState(0);
	const [activeByAgent, setActiveByAgent] = useState<Record<string, string | null>>({});
	// Async opens and warmups can finish after the user selects another session.
	// Keep their results under their own identity, never in a shared active slot.
	const [snapshots, setSnapshots] = useState<ReadonlyMap<string, AcpSessionSnapshot>>(new Map());
	const setSnapshot = useCallback((next: AcpSessionSnapshot) => {
		setSnapshots((current) => new Map(current).set(next.id, next));
	}, []);
	const [error, setError] = useState<string | null>(null);
	/** Per agent, the latest listing asked for; an older reply is not applied over it. */
	const historyRequests = useRef(new Map<string, number>());
	/** The session being opened ahead of a first message, while it is being created. */
	const warming = useRef(new Map<string, Promise<string | null>>());
	/** Where warming last failed; not retried in a loop, but on the next explicit attempt. */
	const warmFailed = useRef<string | null>(null);
	/** A history row is being opened; warming now would only leave a spare session. */
	const opening = useRef(false);
	/** A delayed open or warmup cannot undo a later explicit selection. */
	const selectionVersion = useRef(0);
	/** History rows being opened, so a drop and its pane do not open one twice. */
	const ensuring = useRef(new Map<string, Promise<AcpSessionSnapshot>>());

	const agentId = workspace === NEKO_LOCAL_WORKSPACE ? null : workspace;
	const agent = state.agents.find((entry) => entry.id === agentId && entry.enabled) ?? null;
	const activeId = agent ? (activeByAgent[agent.id] ?? null) : null;
	const snapshot = activeId ? snapshots.get(activeId) ?? null : null;
	const enabledIds = useMemo(
		() => state.agents.filter((entry) => entry.enabled).map((entry) => entry.id),
		[state.agents],
	);
	const enabledKey = enabledIds.join("\n");

	useEffect(() => {
		if (!available) return;
		void api.acpState().then(setState).catch(() => undefined);
		return api.onAcpChanged((next) => {
			setState(next);
			const ids = new Set(next.sessions.map((session) => session.id));
			setSnapshots((current) => [...current.keys()].every((id) => ids.has(id))
				? current : new Map([...current].filter(([id]) => ids.has(id))));
		});
	}, [available]);

	const loadHistory = useCallback(async (id: string) => {
		const request = (historyRequests.current.get(id) ?? 0) + 1;
		historyRequests.current.set(id, request);
		setPendingLoads((count) => count + 1);
		try {
			const next = await api.acpHistory(id);
			if (historyRequests.current.get(id) === request) setHistories((current) => ({ ...current, [id]: next }));
		} catch (cause) {
			if (historyRequests.current.get(id) === request) {
				setHistories((current) => ({ ...current, [id]: { agentId: id, entries: [], error: errorMessage(cause) } }));
			}
		} finally {
			setPendingLoads((count) => count - 1);
		}
	}, []);

	// The sidebar lists every enabled agent, so each one's history is read up
	// front; an agent switched on later is read when it appears.
	const listed = useRef(new Set<string>());
	useEffect(() => {
		for (const id of enabledIds) {
			if (listed.current.has(id)) continue;
			listed.current.add(id);
			void loadHistory(id);
		}
		for (const id of [...listed.current]) if (!enabledIds.includes(id)) listed.current.delete(id);
	}, [enabledKey, loadHistory]);

	// A finished turn renames or re-dates a conversation; a burst of them is
	// answered with one listing per agent.
	useEffect(() => {
		if (!available) return;
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const unsubscribe = api.onAcpHistoryChanged((changed) => {
			if (!listed.current.has(changed)) return;
			const pending = timers.get(changed);
			if (pending) clearTimeout(pending);
			timers.set(
				changed,
				setTimeout(() => {
					timers.delete(changed);
					void loadHistory(changed);
				}, HISTORY_CHANGED_DEBOUNCE_MS),
			);
		});
		return () => {
			for (const timer of timers.values()) clearTimeout(timer);
			unsubscribe();
		};
	}, [available, loadHistory]);

	useEffect(() => {
		if (!activeId) return;
		return subscribeAcpSnapshot(api, activeId, (next) => {
			if (next) setSnapshot(next);
			// Closed while away (idle sessions are closed past a limit): the
			// sidebar row still reopens it from history.
			if (!next && agent) setActiveByAgent((current) => ({ ...current, [agent.id]: null }));
		});
	}, [activeId, agent?.id, setSnapshot]);

	const liveActive = activeId ? state.sessions.find((session) => session.id === activeId) : undefined;

	/**
	 * A new conversation opens its session straight away rather than on the
	 * first message: the model, reasoning and approval pickers are the agent's
	 * own, and it only offers them once a session exists. An agent session with
	 * no message is not kept in the agent's history, so nothing is left behind.
	 */
	const warm = useCallback(
		(target: AcpAgentInfo, directory: string): Promise<string | null> => {
			const key = warmKey(target.id, directory);
			const existing = warming.current.get(key);
			if (existing) return existing;
			const version = selectionVersion.current;
			const pending = api.acpCreate({ agentId: target.id, cwd: directory, warm: true }).then(
				(created) => {
					setSnapshot(created);
					if (selectionVersion.current === version) {
						setActiveByAgent((current) => ({ ...current, [target.id]: created.id }));
					}
					return created.id;
				},
				(cause: unknown) => {
					warmFailed.current = warmKey(target.id, directory);
					setError(errorMessage(cause));
					return null;
				},
			);
			warming.current.set(key, pending);
			void pending.finally(() => {
				if (warming.current.get(key) === pending) warming.current.delete(key);
			});
			return pending;
		},
		[],
	);

	useEffect(() => {
		if (!available || !agent || !cwd) return;
		// An unsent conversation follows the project picker to its new directory.
		if (liveActive?.pristine && liveActive.cwd !== cwd) {
			void api.acpClose(liveActive.id);
			setActiveByAgent((current) => ({ ...current, [agent.id]: null }));
			return;
		}
		if (activeId || warming.current.has(warmKey(agent.id, cwd)) || opening.current) return;
		if (warmFailed.current === warmKey(agent.id, cwd)) return;
		void warm(agent, cwd);
	}, [available, agent, cwd, activeId, liveActive?.pristine, liveActive?.cwd, liveActive?.id, warm]);

	const { rows, targets } = useMemo(
		() =>
			acpAgentsRows(
				enabledIds,
				Object.fromEntries(enabledIds.map((id) => [id, histories[id]?.entries])),
				state.sessions,
			),
		[enabledIds, histories, state.sessions],
	);
	const targetsRef = useRef(targets);
	targetsRef.current = targets;

	const setActive = useCallback((id: string, sessionId: string | null) => {
		setActiveByAgent((current) => ({ ...current, [id]: sessionId }));
	}, []);

	/**
	 * Open a history row, once: a split pane asking for the row it was just
	 * dropped with shares the open the drop itself started.
	 */
	const openEntry = useCallback(
		(rowId: string, target: Extract<AcpAgentRowTarget, { kind: "history" }>): Promise<AcpSessionSnapshot> => {
			const inFlight = ensuring.current.get(rowId);
			if (inFlight) return inFlight;
			const pending = api.acpOpen({
				agentId: target.agentId,
				sessionId: target.entry.sessionId,
				cwd: target.entry.cwd,
				title: target.entry.title,
			});
			ensuring.current.set(rowId, pending);
			const forget = () => {
				if (ensuring.current.get(rowId) === pending) ensuring.current.delete(rowId);
			};
			pending.then(forget, forget);
			return pending;
		},
		[],
	);

	const open = useCallback(
		async (row: Pick<SessionSummary, "id">): Promise<string | null> => {
			const target = targets.get(row.id);
			if (!target) return null;
			const version = ++selectionVersion.current;
			opening.current = false;
			setError(null);
			// The unsent conversation this replaces as that agent's open one has
			// nothing in it to keep. Another agent's stays, for going back to it.
			const replaced = state.sessions.find((session) => session.id === activeByAgent[target.agentId]);
			if (replaced?.pristine && !(target.kind === "live" && target.sessionId === replaced.id)) {
				void api.acpClose(replaced.id);
			}
			if (target.kind === "live") {
				setActive(target.agentId, target.sessionId);
				return target.agentId;
			}
			opening.current = true;
			try {
				const opened = await openEntry(row.id, target);
				setSnapshot(opened);
				if (selectionVersion.current !== version) return null;
				setActive(target.agentId, opened.id);
				return target.agentId;
			} catch (cause) {
				if (selectionVersion.current === version) setError(errorMessage(cause));
				return null;
			} finally {
				if (selectionVersion.current === version) opening.current = false;
			}
		},
		[targets, setActive, state.sessions, activeByAgent, openEntry],
	);

	const liveId = useCallback(
		(rowId: string) => {
			const target = targets.get(rowId);
			return target?.kind === "live" ? target.sessionId : null;
		},
		[targets],
	);

	const ensureLive = useCallback((rowId: string): Promise<string | null> => {
		const target = targetsRef.current.get(rowId);
		if (!target) return Promise.resolve(null);
		if (target.kind === "live") return Promise.resolve(target.sessionId);
		return openEntry(rowId, target).then(
			(opened) => opened.id,
			() => null,
		);
	}, [openEntry]);

	const startNew = useCallback(() => {
		// Already an unsent conversation on screen: that is the new one.
		if (liveActive?.pristine) return;
		selectionVersion.current++;
		opening.current = false;
		warmFailed.current = null;
		if (agent) setActive(agent.id, null);
		setError(null);
	}, [agent, setActive, liveActive]);

	const send = useCallback(
		async (cwd: string, text: string, images?: PromptImageAttachment[]) => {
			if (!agent) return;
			setError(null);
			try {
				let sessionId = activeId ?? (await warming.current.get(warmKey(agent.id, cwd))) ?? null;
				// A session that failed before its first message is replaced, not reused.
				if (sessionId && liveActive?.id === sessionId && liveActive.pristine && liveActive.status === "error") {
					void api.acpClose(sessionId);
					sessionId = null;
				}
				if (!sessionId) {
					const created = await api.acpCreate({ agentId: agent.id, cwd });
					setSnapshot(created);
					setActive(agent.id, created.id);
					sessionId = created.id;
				}
				await api.acpPrompt({ sessionId, text, ...(images?.length ? { images } : {}) });
			} catch (cause) {
				setError(errorMessage(cause));
			}
		},
		[agent, activeId, setActive, liveActive],
	);

	const run = useCallback((action: Promise<unknown>) => {
		setError(null);
		action.catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);

	return {
		agents: state.agents,
		agent,
		rows,
		loading: pendingLoads > 0,
		historyError: (agent && histories[agent.id]?.error) || null,
		snapshot: snapshot && snapshot.agentId === agent?.id ? snapshot : null,
		activeRowId: snapshot && agent && snapshot.id === activeId ? acpRowKey(agent.id, snapshot) : null,
		error,
		dismissError: useCallback(() => setError(null), []),
		open,
		liveId,
		ensureLive,
		startNew,
		send,
		cancel: useCallback(() => {
			if (activeId) run(api.acpCancel(activeId));
		}, [activeId, run]),
		setConfig: useCallback(
			(configId: string, value: string) => {
				if (activeId) run(api.acpSetConfig({ sessionId: activeId, configId, value }));
			},
			[activeId, run],
		),
		respondPermission: useCallback(
			(requestId: string, optionId: string | null) => {
				if (activeId) run(api.acpRespondPermission({ sessionId: activeId, requestId, optionId }));
			},
			[activeId, run],
		),
		refreshHistory: useCallback(() => {
			for (const id of enabledIds) void loadHistory(id);
		}, [enabledIds, loadHistory]),
	};
}
