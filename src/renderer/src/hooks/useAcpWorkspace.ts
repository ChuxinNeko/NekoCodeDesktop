import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PromptImageAttachment, SessionSummary } from "../../../shared/agent";
import {
	NEKO_LOCAL_WORKSPACE,
	type AcpAgentInfo,
	type AcpHistory,
	type AcpSessionSnapshot,
	type AcpState,
} from "../../../shared/acp";
import { acpRowKey, acpSessionRows } from "../../../shared/acp-sessions";
import { api, errorMessage } from "../api";

const HISTORY_CHANGED_DEBOUNCE_MS = 400;

const warmKey = (agentId: string, cwd: string) => JSON.stringify([agentId, cwd]);

export interface AcpWorkspace {
	/** Every configured agent, enabled or not. */
	agents: AcpAgentInfo[];
	/** The agent the current workspace is, or null in NekoLocal. */
	agent: AcpAgentInfo | null;
	rows: SessionSummary[];
	loading: boolean;
	/** The agent could not list its history; open conversations still show. */
	historyError: string | null;
	snapshot: AcpSessionSnapshot | null;
	activeRowId: string | null;
	error: string | null;
	dismissError: () => void;
	open: (row: SessionSummary) => Promise<void>;
	/** Leave the open conversation for an empty composer, as "new session" does. */
	startNew: () => void;
	send: (cwd: string, text: string, images?: PromptImageAttachment[]) => Promise<void>;
	cancel: () => void;
	setConfig: (configId: string, value: string) => void;
	respondPermission: (requestId: string, optionId: string | null) => void;
	refreshHistory: () => void;
}

/**
 * The ACP side of the workspace switch: which agent is selected, its
 * conversations for the sidebar, and the one on screen.
 *
 * Each agent remembers its own open conversation, so switching workspaces and
 * back returns to where that agent was left — the workspaces do not share a
 * selection any more than they share a history.
 */
export function useAcpWorkspace(workspace: string, cwd: string | null): AcpWorkspace {
	const available = api.runtime !== "web";
	const [state, setState] = useState<AcpState>({ agents: [], sessions: [] });
	const [histories, setHistories] = useState<Record<string, AcpHistory>>({});
	const [loading, setLoading] = useState(false);
	const [activeByAgent, setActiveByAgent] = useState<Record<string, string | null>>({});
	const [snapshot, setSnapshot] = useState<AcpSessionSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const historyRequest = useRef(0);
	/** The session being opened ahead of a first message, while it is being created. */
	const warming = useRef<Promise<string | null> | null>(null);
	/** Where warming last failed; not retried in a loop, but on the next explicit attempt. */
	const warmFailed = useRef<string | null>(null);
	/** A history row is being opened; warming now would only leave a spare session. */
	const opening = useRef(false);

	const agentId = workspace === NEKO_LOCAL_WORKSPACE ? null : workspace;
	const agent = state.agents.find((entry) => entry.id === agentId && entry.enabled) ?? null;
	const activeId = agent ? (activeByAgent[agent.id] ?? null) : null;

	useEffect(() => {
		if (!available) return;
		void api.acpState().then(setState).catch(() => undefined);
		return api.onAcpChanged(setState);
	}, [available]);

	const loadHistory = useCallback(
		async (id: string) => {
			const request = ++historyRequest.current;
			setLoading(true);
			try {
				const next = await api.acpHistory(id);
				setHistories((current) => ({ ...current, [id]: next }));
			} catch (cause) {
				setHistories((current) => ({ ...current, [id]: { agentId: id, entries: [], error: errorMessage(cause) } }));
			} finally {
				if (request === historyRequest.current) setLoading(false);
			}
		},
		[],
	);

	useEffect(() => {
		if (agent) void loadHistory(agent.id);
	}, [agent?.id, loadHistory]);

	// A finished turn renames or re-dates a conversation; a burst of them is
	// answered with one listing.
	useEffect(() => {
		if (!available) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = api.onAcpHistoryChanged((changed) => {
			if (changed !== agentId) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void loadHistory(changed), HISTORY_CHANGED_DEBOUNCE_MS);
		});
		return () => {
			if (timer) clearTimeout(timer);
			unsubscribe();
		};
	}, [available, agentId, loadHistory]);

	useEffect(() => {
		if (!activeId) {
			setSnapshot(null);
			return;
		}
		let cancelled = false;
		void api.acpSnapshot(activeId).then((next) => {
			if (cancelled) return;
			setSnapshot(next);
			// Closed while away (idle sessions are closed past a limit): the
			// sidebar row still reopens it from history.
			if (!next && agent) setActiveByAgent((current) => ({ ...current, [agent.id]: null }));
		});
		const unsubscribe = api.onAcpSnapshot((next) => {
			if (next.id === activeId) setSnapshot(next);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [activeId, agent?.id]);

	const liveActive = activeId ? state.sessions.find((session) => session.id === activeId) : undefined;

	/**
	 * A new conversation opens its session straight away rather than on the
	 * first message: the model, reasoning and approval pickers are the agent's
	 * own, and it only offers them once a session exists. An agent session with
	 * no message is not kept in the agent's history, so nothing is left behind.
	 */
	const warm = useCallback(
		(target: AcpAgentInfo, directory: string): Promise<string | null> => {
			const pending = api.acpCreate({ agentId: target.id, cwd: directory, warm: true }).then(
				(created) => {
					setSnapshot(created);
					setActiveByAgent((current) => ({ ...current, [target.id]: created.id }));
					return created.id;
				},
				(cause: unknown) => {
					warmFailed.current = warmKey(target.id, directory);
					setError(errorMessage(cause));
					return null;
				},
			);
			warming.current = pending;
			void pending.finally(() => {
				if (warming.current === pending) warming.current = null;
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
		if (activeId || warming.current || opening.current) return;
		if (warmFailed.current === warmKey(agent.id, cwd)) return;
		void warm(agent, cwd);
	}, [available, agent, cwd, activeId, liveActive?.pristine, liveActive?.cwd, liveActive?.id, warm]);

	const history = agent ? histories[agent.id] : undefined;
	const { rows, targets } = useMemo(
		() => (agent ? acpSessionRows(agent.id, history?.entries ?? [], state.sessions) : { rows: [], targets: new Map() }),
		[agent, history, state.sessions],
	);

	const setActive = useCallback((id: string, sessionId: string | null) => {
		setActiveByAgent((current) => ({ ...current, [id]: sessionId }));
	}, []);

	const open = useCallback(
		async (row: SessionSummary) => {
			if (!agent) return;
			const target = targets.get(row.id);
			if (!target) return;
			setError(null);
			// The unsent conversation being left has nothing in it to keep.
			const spare = liveActive?.pristine ? liveActive.id : null;
			if (spare) void api.acpClose(spare);
			if (target.kind === "live") {
				setActive(agent.id, target.sessionId);
				return;
			}
			opening.current = true;
			try {
				const opened = await api.acpOpen({
					agentId: agent.id,
					sessionId: target.entry.sessionId,
					cwd: target.entry.cwd,
					title: target.entry.title,
				});
				setSnapshot(opened);
				setActive(agent.id, opened.id);
			} catch (cause) {
				setError(errorMessage(cause));
			} finally {
				opening.current = false;
			}
		},
		[agent, targets, setActive, liveActive],
	);

	const startNew = useCallback(() => {
		// Already an unsent conversation on screen: that is the new one.
		if (liveActive?.pristine) return;
		warmFailed.current = null;
		if (agent) setActive(agent.id, null);
		setError(null);
	}, [agent, setActive, liveActive]);

	const send = useCallback(
		async (cwd: string, text: string, images?: PromptImageAttachment[]) => {
			if (!agent) return;
			setError(null);
			try {
				let sessionId = activeId ?? (warming.current ? await warming.current : null);
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
		loading,
		historyError: history?.error ?? null,
		snapshot: snapshot && snapshot.agentId === agent?.id ? snapshot : null,
		activeRowId: snapshot && agent && snapshot.id === activeId ? acpRowKey(agent.id, snapshot) : null,
		error,
		dismissError: useCallback(() => setError(null), []),
		open,
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
			if (agent) void loadHistory(agent.id);
		}, [agent, loadHistory]),
	};
}
