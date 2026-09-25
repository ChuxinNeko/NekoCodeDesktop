import type { FastContextConfig } from "../../shared/fast-context";
import type { FusionConfig } from "../../shared/fusion";
import { elementSelectionText, type BrowserPreviewRequest, type ComposerInsertion } from "../../shared/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	AgentDefaults,
	AgentSnapshot,
	ExecutionMode,
	SendPromptRequest,
	SessionSummary,
	ThinkingLevel,
} from "../../shared/agent";
import type { WorkMode } from "../../shared/workflow";
import type { CheckpointSummary } from "../../shared/checkpoints";
import { projectLabel } from "../../shared/paths";
import { mergeActiveSession, workspaceKey } from "../../shared/sessions";
import { api, errorMessage } from "./api";
import { AutomationsPage } from "./components/automations/AutomationsPage";
import { AcpChatView } from "./components/agents/AcpChatView";
import { WorkspacePicker, workspaceName } from "./components/agents/WorkspacePicker";
import { NEKO_LOCAL_WORKSPACE } from "../../shared/acp";
import { useAcpWorkspace } from "./hooks/useAcpWorkspace";
import { ChatView } from "./components/ChatView";
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog";
import {
	RightDock,
	taskTabId,
	type DockTabId,
	type DockTool,
} from "./components/dock/RightDock";
import { PullRequestsPage } from "./components/pullRequests/PullRequestsPage";
import { ReviewPanel } from "./components/ReviewPanel";
import { SettingsPage, type SettingsSectionId } from "./components/settings/SettingsPage";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary";
import { AutomaticUpdateDialog } from "./components/updates/UpdateDialog";
import { useHostDirectoryPicker } from "./components/HostDirectoryPicker";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { TitleBar } from "./components/TitleBar";
import { useAppearanceVariables } from "./hooks/useAppearanceVariables";
import { useSessions } from "./hooks/useSessions";
import { useTheme } from "./hooks/useTheme";
import { DEFAULT_UI_DENSITY, type UiDensity } from "./lib/appDensity";
import { DEFAULT_CHAT_WIDTH, type ChatWidthMode } from "./lib/chatWidth";
import { cn } from "./lib/utils";
import { shareStructure } from "./lib/structural-share";
import { CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME } from "./components/chat/composerPickerStyles";

const PROJECT_STORAGE_KEY = "nekocode:project-cwd";
const WORKSPACES_STORAGE_KEY = "nekocode:workspaces";
const DENSITY_STORAGE_KEY = "nekocode:density";
const CHAT_WIDTH_STORAGE_KEY = "nekocode:chat-width";
const DOCK_WIDTH_STORAGE_KEY = "nekocode:dock-width";
const DOCK_OPEN_STORAGE_KEY = "nekocode:dock-open";
const SIDEBAR_OPEN_STORAGE_KEY = "nekocode:sidebar-open";
/** NekoLocal or the id of an external agent; see the workspace picker. */
const AGENT_WORKSPACE_STORAGE_KEY = "nekocode:agent-workspace";
const DEFAULT_DOCK_WIDTH = 460;
const MIN_DOCK_WIDTH = 320;
const MIN_CHAT_WIDTH = 480;

export type WorkspaceView = "chat" | "review" | "pull-requests" | "automations" | "settings";

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// storage unavailable; preferences just do not persist
	}
}

export default function App() {
	const { resolvedTheme, setTheme, theme } = useTheme();
	const browserAvailable = api.runtime !== "web";
	const pickDirectory = useHostDirectoryPicker();
	// Fall back to the home directory rather than to "no project": the welcome
	// screen is usable immediately, and the folder chip is right there to change.
	const [cwd, setCwd] = useState<string | null>(
		() => readStored(PROJECT_STORAGE_KEY) ?? (api.homeDir || null),
	);
	const [density] = useState<UiDensity>(() => {
		const stored = readStored(DENSITY_STORAGE_KEY);
		return stored === "compact" || stored === "spacious" || stored === "comfortable"
			? stored
			: DEFAULT_UI_DENSITY;
	});
	const [chatWidth] = useState<ChatWidthMode>(() => {
		const stored = readStored(CHAT_WIDTH_STORAGE_KEY);
		return stored === "wide" || stored === "full" || stored === "standard"
			? stored
			: DEFAULT_CHAT_WIDTH;
	});

	useAppearanceVariables({
		density,
		chatWidth,
		chatFontSizePx: 12,
		terminalFontSizePx: 12,
	});

	const [view, setView] = useState<WorkspaceView>("chat");
	/** The settings section to land on — set when a shortcut elsewhere opens settings. */
	const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined);
	const selectView = (next: WorkspaceView) => {
		if (next === "settings") setSettingsSection(undefined);
		setView(next);
	};
	const sessions = useSessions();
	// Which agent the conversation is with. Remembered across restarts; the
	// WebUI has no bridge to external agents, so it is always NekoLocal there.
	const [workspace, setWorkspaceState] = useState<string>(() =>
		api.runtime === "web" ? NEKO_LOCAL_WORKSPACE : (readStored(AGENT_WORKSPACE_STORAGE_KEY) ?? NEKO_LOCAL_WORKSPACE),
	);
	const setWorkspace = (next: string) => {
		setWorkspaceState(next);
		writeStored(AGENT_WORKSPACE_STORAGE_KEY, next);
		setView("chat");
	};
	const acp = useAcpWorkspace(workspace, cwd);
	const acpActive = workspace !== NEKO_LOCAL_WORKSPACE && acp.agent !== null;
	// An agent removed or switched off in settings takes its workspace with it.
	useEffect(() => {
		if (workspace === NEKO_LOCAL_WORKSPACE || acp.agents.length === 0) return;
		if (!acp.agents.some((agent) => agent.id === workspace && agent.enabled)) {
			setWorkspaceState(NEKO_LOCAL_WORKSPACE);
			writeStored(AGENT_WORKSPACE_STORAGE_KEY, NEKO_LOCAL_WORKSPACE);
		}
	}, [workspace, acp.agents]);
	const [workspaces, setWorkspaces] = useState<string[]>(() => {
		try {
			const value: unknown = JSON.parse(readStored(WORKSPACES_STORAGE_KEY) ?? "[]");
			return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) : [];
		} catch { return []; }
	});
	useEffect(() => {
		if (!cwd) return;
		setWorkspaces((previous) => {
			if (previous.some((path) => workspaceKey(path) === workspaceKey(cwd))) return previous;
			const next = [...previous, cwd];
			writeStored(WORKSPACES_STORAGE_KEY, JSON.stringify(next));
			return next;
		});
	}, [cwd]);
	const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
	/**
	 * Put a snapshot from main on screen, keeping every part of the current one
	 * it left unchanged. Each snapshot arrives as a fresh copy of the whole
	 * transcript; carrying the old objects over is what lets the rows that did
	 * not change skip rendering while the tail streams.
	 */
	const showSnapshot = (next: AgentSnapshot | null) =>
		setSnapshot((previous) => (next ? shareStructure(previous, next) : null));
	const [browserPreview, setBrowserPreview] = useState<BrowserPreviewRequest | null>(null);
	const [composerInsertion, setComposerInsertion] = useState<ComposerInsertion | null>(null);
	// The conversation on screen owns the browser panel: a preview from a
	// session that is not showing — NekoLocal or ACP — is not opened over it.
	const previewScope = acpActive
		? { cwd: acp.snapshot?.cwd ?? cwd, sessionId: acp.snapshot?.id }
		: { cwd, sessionId: snapshot?.session.id };
	const currentPreviewScope = useRef(previewScope);
	currentPreviewScope.current = previewScope;
	const [defaults, setDefaults] = useState<AgentDefaults | null>(null);
	const [busy, setBusy] = useState(false);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const loadingEarlierRef = useRef(false);
	const sessionTransition = useRef(false);
	/** Bumped by every open or create; only the latest one's reply is applied. */
	const transitionSeq = useRef(0);
	const [error, setError] = useState<string | null>(null);
	/**
	 * The checkpoint a confirmation is open for.
	 *
	 * Held here rather than in the transcript or the dock because both of them
	 * can raise it and there must only ever be one dialog — a modal opened twice
	 * over the same restore is how a double-click turns into two rewinds.
	 */
	const [restoreTarget, setRestoreTarget] = useState<CheckpointSummary | null>(null);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(
		() => readStored(SIDEBAR_OPEN_STORAGE_KEY) !== "0",
	);
	const [dockOpen, setDockOpen] = useState(
		() => readStored(DOCK_OPEN_STORAGE_KEY) === "1",
	);
	const [dockTabs, setDockTabs] = useState<DockTabId[]>([]);
	const [dockActive, setDockActive] = useState<DockTabId | null>(null);
	/**
	 * The file a transcript tool row asked the Files pane to open.
	 *
	 * A nonce rather than the path alone, because clicking the same "Read file"
	 * row twice must re-raise the preview even when nothing else changed.
	 */
	const [dockFile, setDockFile] = useState<{ path: string; nonce: number } | null>(null);
	const [dockWidth, setDockWidth] = useState(() => {
		const stored = Number(readStored(DOCK_WIDTH_STORAGE_KEY));
		return Number.isFinite(stored) && stored >= MIN_DOCK_WIDTH
			? stored
			: DEFAULT_DOCK_WIDTH;
	});
	const dockDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

	const setDockOpenStored = (open: boolean) => {
		setDockOpen(open);
		writeStored(DOCK_OPEN_STORAGE_KEY, open ? "1" : "0");
	};

	/** Show a tab, opening the dock and adding the tab if either is missing. */
	const openDockTab = (tab: DockTabId) => {
		setDockTabs((current) => (current.includes(tab) ? current : [...current, tab]));
		setDockActive(tab);
		setDockOpenStored(true);
	};

	/** Open a file in the dock's Files pane — the "Read file" tool row's click. */
	const openDockFile = (path: string) => {
		setDockFile({ path, nonce: Date.now() });
		openDockTab("files");
	};

	// A file request names a path inside one project; a project switch retires it.
	useEffect(() => {
		setDockFile(null);
	}, [cwd]);

	/**
	 * Close a tab and hand focus to a neighbour.
	 *
	 * The tab to the left, because that is where the eye already is after the one
	 * you were reading disappears; with nothing left the dock falls back to the
	 * tool menu rather than closing itself out from under the user.
	 */
	const closeDockTab = (tab: DockTabId) => {
		const at = dockTabs.indexOf(tab);
		if (at === -1) return;
		const next = dockTabs.filter((entry) => entry !== tab);
		setDockTabs(next);
		if (dockActive === tab) setDockActive(next[at - 1] ?? next[at] ?? null);
	};

	/** Open the dock on a tool, or close it when that tool is already showing. */
	const toggleDockTool = (tool: DockTool) => {
		if (dockOpen && dockActive === tool) setDockOpenStored(false);
		else openDockTab(tool);
	};

	// A worker's tab outlives the worker itself only as long as the session keeps
	// reporting it; once it is gone from the snapshot the tab has nothing to show.
	const liveTasks = useMemo(() => snapshot?.workflow.tasks ?? [], [snapshot]);
	useEffect(() => {
		const ids = new Set(liveTasks.map((task) => taskTabId(task.id)));
		setDockTabs((current) => {
			const next = current.filter((tab) => !tab.startsWith("task:") || ids.has(tab));
			return next.length === current.length ? current : next;
		});
	}, [liveTasks]);

	// Whatever removed a tab — a close, a session change — the tab on screen has
	// to be one that still exists.
	useEffect(() => {
		if (dockActive !== null && !dockTabs.includes(dockActive))
			setDockActive(dockTabs[dockTabs.length - 1] ?? null);
	}, [dockTabs, dockActive]);

	// Codex-style dock shortcuts, advertised next to each level-1 menu row.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
			const tool: DockTool | null =
				event.code === "Backquote" && !event.shiftKey
					? "terminal"
					: event.code === "KeyT" && !event.shiftKey && browserAvailable
						? "browser"
						: event.code === "KeyP" && !event.shiftKey
							? "files"
							: event.code === "KeyG" && event.shiftKey
								? "review"
								: event.code === "KeyH" && event.shiftKey
									? "checkpoints"
									: null;
			if (!tool) return;
			event.preventDefault();
			toggleDockTool(tool);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	// A session that has just been started is not on disk yet, so the list from
	// main does not have it. Joining its snapshot in is what puts the row —
	// placeholder title and running dot — in the sidebar from the first prompt.
	const sessionRows = useMemo(
		() => mergeActiveSession(sessions.sessions, snapshot?.session),
		[sessions.sessions, snapshot?.session],
	);

	// The open session owns the project path, and a snapshot can arrive without
	// anyone here having opened it: a restore on launch, a background task made
	// active, a session that moved into its own worktree. Left behind, `cwd`
	// roots the Files pane in a directory the transcript has nothing to do with,
	// and every "Read file" row answers "path escapes project root".
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;

	useEffect(() => {
		const unsubscribe = api.onAgentSnapshot((next) => {
			showSnapshot(next);
			setError(next?.error ?? null);
			const sessionCwd = next?.session.cwd;
			if (!sessionCwd || sessionCwd === cwdRef.current) return;
			cwdRef.current = sessionCwd;
			setCwd(sessionCwd);
			writeStored(PROJECT_STORAGE_KEY, sessionCwd);
		});
		return unsubscribe;
	}, []);

	useEffect(() => api.onAgentDefaults(setDefaults), []);

	// Clicking a finished task's notification opens it. Routed through a ref
	// because the subscription outlives the render that made `openSession`.
	const openSessionRef = useRef<(session: SessionSummary) => Promise<void>>(async () => undefined);
	useEffect(() => api.onRevealSession((session) => void openSessionRef.current(session)), []);

	useEffect(() => {
		if (!browserAvailable) return;
		return api.onBrowserPreview((request) => {
		const scope = currentPreviewScope.current;
		if (scope.cwd !== request.cwd || scope.sessionId !== request.sessionId) return;
		setBrowserPreview(request);
		setDockTabs((tabs) => tabs.includes("browser") ? tabs : [...tabs, "browser"]);
		setDockActive("browser");
		setDockOpen(true);
		writeStored(DOCK_OPEN_STORAGE_KEY, "1");
		});
	}, []);
	// A screenshot needs the automation page painted, whichever session is on
	// screen; BrowserPanel picks the page's own tab.
	useEffect(() => {
		if (!browserAvailable) return;
		return api.onBrowserRevealAutomation(() => {
			setDockTabs((tabs) => tabs.includes("browser") ? tabs : [...tabs, "browser"]);
			setDockActive("browser");
			setDockOpen(true);
		});
	}, []);
	useEffect(() => {
		if (!browserAvailable) return;
		return api.onBrowserElementSelected((selection) => {
			setView("chat");
			setComposerInsertion((pending) => ({ id: crypto.randomUUID(), text: (pending?.text ?? "") + elementSelectionText(selection) }));
		});
	}, []);

	// The welcome screen's pickers are resolved per directory — project settings
	// can change which model a new session starts with.
	useEffect(() => {
		if (snapshot || !cwd) return;
		let cancelled = false;
		api
			.agentDefaults(cwd)
			.then((next) => {
				if (!cancelled) setDefaults(next);
			})
			.catch((cause) => {
				if (!cancelled) setError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [snapshot, cwd]);

	// A directory passed on the command line is an explicit request, so it wins
	// over the remembered project.
	useEffect(() => {
		let cancelled = false;
		api
			.initialProjectDir()
			.then((dir) => {
				if (cancelled || !dir) return;
				setCwd(dir);
				setSnapshot(null);
				writeStored(PROJECT_STORAGE_KEY, dir);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	/** Point the app at a project; in an agent workspace that also means a new conversation there. */
	const switchProject = (path: string) => {
		setCwd(path);
		writeStored(PROJECT_STORAGE_KEY, path);
		acp.startNew();
		setView("chat");
	};

	const pickProject = async () => {
		if (sessionTransition.current) return;
		try {
			const picked = await pickDirectory(cwd ?? api.homeDir);
			if (!picked) return;
			if (acpActive) switchProject(picked);
			else await createSession(picked);
		} catch (cause) { setError(errorMessage(cause)); }
	};

	const openAcpSession = (row: SessionSummary) => {
		if (row.cwd) {
			setCwd(row.cwd);
			writeStored(PROJECT_STORAGE_KEY, row.cwd);
		}
		setView("chat");
		void acp.open(row);
	};

	const workspacePicker =
		api.runtime === "web" ? null : (
			<WorkspacePicker
				agents={acp.agents}
				disabled={busy}
				onChange={setWorkspace}
				onManage={() => {
					setSettingsSection("agents");
					setView("settings");
				}}
				value={acpActive ? workspace : NEKO_LOCAL_WORKSPACE}
			/>
		);

	/**
	 * Opening a session neither locks the sidebar nor swallows the next click: a
	 * long transcript can take a moment to arrive, and a user who clicks on
	 * meanwhile means the later row. Main serializes the switches, so the last
	 * one asked for is the one that ends up active — and the only reply that
	 * gets to put itself on screen.
	 */
	const openSession = async (session: SessionSummary) => {
		const seq = ++transitionSeq.current;
		try {
			const next = await api.agentOpen({ cwd: session.cwd, sessionFile: session.sessionFile });
			if (seq !== transitionSeq.current) return;
			setCwd(next.session.cwd);
			writeStored(PROJECT_STORAGE_KEY, next.session.cwd);
			showSnapshot(next);
			setView("chat");
			setError(null);
		} catch (cause) {
			if (seq === transitionSeq.current) setError(errorMessage(cause));
		}
	};
	openSessionRef.current = openSession;

	const createSession = async (targetCwd = cwd): Promise<boolean> => {
		if (!targetCwd || sessionTransition.current) return false;
		sessionTransition.current = true;
		const seq = ++transitionSeq.current;
		setBusy(true);
		try {
			const next = await api.agentCreate(targetCwd);
			// A session opened from the sidebar meanwhile is the one on screen now;
			// the caller must not go on to prompt the one it is replacing.
			if (seq !== transitionSeq.current) return false;
			setCwd(next.session.cwd);
			writeStored(PROJECT_STORAGE_KEY, next.session.cwd);
			showSnapshot(next);
			setView("chat");
			setError(null);
			return true;
		} catch (cause) {
			setError(errorMessage(cause));
			return false;
		} finally {
			sessionTransition.current = false;
			setBusy(false);
		}
	};

	/**
	 * Reach further back into a long session. Main only sends the tail of a
	 * transcript, so opening one costs what is on screen rather than everything
	 * the session ever did; scrolling to the top asks for the page before it.
	 */
	const loadEarlier = async () => {
		if (loadingEarlierRef.current) return;
		loadingEarlierRef.current = true;
		setLoadingEarlier(true);
		// A reply that lands after the user moved to another session is not theirs.
		const seq = transitionSeq.current;
		try {
			const next = await api.agentLoadEarlier();
			if (next && seq === transitionSeq.current) showSnapshot(next);
		} catch (cause) {
			if (seq === transitionSeq.current) setError(errorMessage(cause));
		} finally {
			loadingEarlierRef.current = false;
			setLoadingEarlier(false);
		}
	};

	/** The rest of a tool result the window was only sent the head of. */
	const loadToolOutput = async (toolCallId: string, offset: number) => {
		const chunk = await api.agentToolOutput(toolCallId, offset);
		if (!chunk) throw new Error("Tool output is unavailable");
		return chunk;
	};

	const send = async (request: SendPromptRequest) => {
		try {
			const result = await api.agentSend(request);
			if (!result.accepted) {
				setError(result.error);
				return;
			}
			if (result.action === "new-session") await createSession();
			if (result.action === "open-terminal") setTerminalOpen(true);
			// The list refreshes itself: main pushes `sessionsChanged` once the
			// prompt names the session and again when the run settles.
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	/**
	 * Run a prompt in a session of its own, leaving this one on screen.
	 *
	 * Nothing here touches the selection: main creates the task unselected, and
	 * the only trace of it in this window is the row that `sessionsChanged` adds
	 * to the sidebar, running dot and all. Clicking that row opens it the usual
	 * way — full screen, like every other session.
	 */
	const startBackgroundTask = async (text: string) => {
		const target = snapshot?.session.cwd ?? cwd;
		if (!target) return;
		try {
			const result = await api.agentStartBackground({ cwd: target, text });
			// A warning means the task started on terms the user did not pick —
			// most often sharing the directory when isolation was asked for.
			if (!result.accepted) setError(result.error);
			else if (result.warning) setError(result.warning);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	/** Welcome screen: the first prompt both opens the session and is sent to it. */
	const startSession = async (request: SendPromptRequest) => {
		if (!(await createSession())) return;
		await send(request);
	};

	// A null return means the pick landed on the welcome screen: it is held as
	// the pending default and comes back through onAgentDefaults.
	const setFusion = async (config: FusionConfig) => {
		try {
			const next = await api.agentSetFusion(config);
			if (next) showSnapshot(next);
		} catch (cause) { setError(errorMessage(cause)); }
	};

	const setFastContext = async (config: FastContextConfig) => {
		try {
			const next = await api.agentSetFastContext(config);
			if (next) showSnapshot(next);
		} catch (cause) { setError(errorMessage(cause)); }
	};

	const setModel = async (modelKey: string) => {
		try {
			const next = await api.agentSetModel(modelKey);
			if (next) showSnapshot(next);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const setThinking = async (level: ThinkingLevel) => {
		try {
			const next = await api.agentSetThinking(level);
			if (next) showSnapshot(next);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const setWorkMode = async (mode: WorkMode) => {
		try {
			const next = await api.agentSetWorkMode(mode);
			if (next) showSnapshot(next);
		} catch (cause) { setError(errorMessage(cause)); }
	};

	const setMode = async (mode: ExecutionMode) => {
		try {
			const next = await api.agentSetMode(mode);
			if (next) showSnapshot(next);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	/**
	 * A rewind has happened. The prompt that started the undone turn goes back to
	 * the composer, because rewinding is nearly always a prelude to asking again
	 * differently and retyping it is the part nobody wants; warnings are surfaced
	 * rather than swallowed, since "restored" with a file it could not write is
	 * not the same outcome as "restored".
	 */
	const checkpointRestored = (result: { editorText?: string; warnings: string[] }) => {
		if (result.editorText) {
			setView("chat");
			setComposerInsertion({ id: crypto.randomUUID(), text: result.editorText });
		}
		setError(result.warnings.length ? result.warnings.join("；") : null);
	};

	const startDockDrag = (event: React.MouseEvent) => {
		event.preventDefault();
		dockDragRef.current = { startX: event.clientX, startWidth: dockWidth };
		const onMove = (moveEvent: MouseEvent) => {
			const drag = dockDragRef.current;
			if (!drag) return;
			const maxWidth = Math.max(
				MIN_DOCK_WIDTH,
				window.innerWidth - MIN_CHAT_WIDTH,
			);
			const next = Math.min(
				maxWidth,
				Math.max(MIN_DOCK_WIDTH, drag.startWidth - (moveEvent.clientX - drag.startX)),
			);
			setDockWidth(next);
		};
		const onUp = () => {
			dockDragRef.current = null;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			setDockWidth((width) => {
				writeStored(DOCK_WIDTH_STORAGE_KEY, String(width));
				return width;
			});
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	return (
		<div className="app-window-backdrop flex h-dvh min-h-0 w-full flex-col overflow-hidden text-foreground">
			<TitleBar
				projectLabel={cwd ? projectLabel(cwd, api.homeDir) : null}
				sidebarOpen={sidebarOpen}
				onToggleSidebar={() =>
					setSidebarOpen((open) => {
						writeStored(SIDEBAR_OPEN_STORAGE_KEY, open ? "0" : "1");
						return !open;
					})
				}
				dockOpen={dockOpen}
				onToggleDock={() => setDockOpenStored(!dockOpen)}
			/>
			<div className="app-chrome-surface flex min-h-0 min-w-0 flex-1 overflow-hidden">
				{sidebarOpen ? (
					<Sidebar
						cwd={cwd}
						workspaces={workspaces}
						sessions={acpActive ? acp.rows : sessionRows}
						sessionsLoading={acpActive ? acp.loading : sessions.loading}
						workspaceName={workspaceName(acpActive ? workspace : NEKO_LOCAL_WORKSPACE, acp.agents)}
						sessionsReadOnly={acpActive}
						activeSessionId={acpActive ? acp.activeRowId : (snapshot?.session.id ?? null)}
						streaming={acpActive ? (acp.snapshot?.streaming ?? false) : (snapshot?.streaming ?? false)}
						view={view}
						busy={busy}
						theme={theme}
						resolvedTheme={resolvedTheme}
						browserOpen={dockOpen && dockActive === "browser"}
						onPickProject={pickProject}
						onNewSession={() => {
							if (!acpActive) return void createSession();
							acp.startNew();
							setView("chat");
						}}
						onNewWorkspaceSession={(path) => (acpActive ? switchProject(path) : void createSession(path))}
						onOpenSession={acpActive ? openAcpSession : openSession}
						onRenameSession={(session, title) => {
							if (!acpActive) void sessions.rename(session, title);
						}}
						onDeleteSession={(session) => {
							if (!acpActive) void sessions.remove(session);
						}}
						onSelectView={selectView}
						onToggleBrowser={() => toggleDockTool("browser")}
						onToggleTheme={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
					/>
				) : null}
				<main
					className={cn(
						CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
						"flex min-h-0 min-w-0 flex-1 flex-col rounded-tl-lg",
						dockOpen && "rounded-tr-lg",
					)}
				>
					<ViewErrorBoundary resetKey={`${view}:${snapshot?.session.id ?? ""}`}>
					{view === "settings" ? (
						<SettingsPage
							initialSection={settingsSection}
							key={settingsSection ?? "default"}
							onClose={() => setView("chat")}
							cwd={snapshot?.session.cwd ?? cwd}
							projects={workspaces}
						/>
					) : view === "review" ? (
						<ReviewPanel cwd={cwd} onClose={() => setView("chat")} />
					) : view === "pull-requests" ? (
						<PullRequestsPage cwd={cwd} onClose={() => setView("chat")} />
					) : view === "automations" ? (
						<AutomationsPage cwd={cwd} onClose={() => setView("chat")} />
					) : acpActive && acp.agent ? (
						<AcpChatView
							insertion={composerInsertion}
							onInsertionConsumed={(id) => setComposerInsertion((current) => (current?.id === id ? null : current))}
							agent={acp.agent}
							composerHeader={workspacePicker}
							cwd={acp.snapshot?.cwd ?? cwd}
							error={acp.error}
							historyError={acp.historyError}
							onAbort={acp.cancel}
							onDismissError={acp.dismissError}
							onPickProject={pickProject}
							onRespondPermission={acp.respondPermission}
							onSend={(request) => {
								const target = acp.snapshot?.cwd ?? cwd;
								if (target) void acp.send(target, request.text, request.images);
							}}
							onSetConfig={acp.setConfig}
							snapshot={acp.snapshot}
						/>
					) : (
						<ChatView
							composerHeader={workspacePicker}
							onGoalAction={async (action) => {
								const next = await api.agentGoal(action);
								if (next) showSnapshot(next);
							}}
							loadMentions={(query) => api.agentMentions(query, snapshot?.session.cwd ?? cwd ?? undefined)}
							insertion={composerInsertion}
							onInsertionConsumed={(id) => setComposerInsertion((current) => current?.id === id ? null : current)}
							cwd={cwd}
							snapshot={snapshot}
							earlierAvailable={(snapshot?.earlierCells ?? 0) > 0}
							loadingEarlier={loadingEarlier}
							onLoadEarlier={() => void loadEarlier()}
							onLoadToolOutput={loadToolOutput}
							defaults={defaults}
							busy={busy}
							error={error}
							terminalOpen={terminalOpen}
							browserAvailable={browserAvailable}
							browserOpen={dockOpen && dockActive === "browser"}
							onPickProject={pickProject}
							onSend={send}
							onSendBackground={(text) => void startBackgroundTask(text)}
							onAbort={() => void api.agentAbort()}
							onSetFusion={setFusion}
							onSetFastContext={setFastContext}
							onSetModel={setModel}
							onSetThinking={setThinking}
							onSetMode={setMode}
							onSetWorkMode={setWorkMode}
							onOpenReview={() => setView("review")}
							onToggleTerminal={() => setTerminalOpen((open) => !open)}
							onToggleBrowser={() => toggleDockTool("browser")}
							onOpenTask={(taskId) => openDockTab(taskTabId(taskId))}
							onOpenFile={openDockFile}
							onDismissError={() => setError(null)}
							onStartSession={startSession}
							onWorktreeReleased={() => sessions.refresh()}
							onWorktreeError={setError}
							onRestoreCheckpoint={setRestoreTarget}
							onOpenCheckpoints={() => openDockTab("checkpoints")}
						/>
					)}
					</ViewErrorBoundary>
					{terminalOpen ? (
						<TerminalPanel cwd={cwd} onClose={() => setTerminalOpen(false)} />
					) : null}
				</main>
				{dockOpen ? (
					<div
						aria-hidden="true"
						className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
						onMouseDown={startDockDrag}
					/>
				) : null}
				{/* The dock stays mounted while collapsed so its width transition can
				    play and opened tools keep their state; `invisible` panes inside
				    keep webviews laid out rather than torn down. */}
				<aside
					aria-hidden={!dockOpen}
					className={cn(
						"shrink-0 overflow-hidden transition-[width] duration-200 ease-out",
						!dockOpen && "pointer-events-none",
					)}
					style={{ width: dockOpen ? dockWidth : 0 }}
				>
					<div
						className="flex h-full flex-col overflow-hidden rounded-tl-lg border-l border-[color:var(--app-surface-divider)]"
						style={{ width: dockWidth }}
					>
						<RightDock
							browserPreview={browserPreview}
							visible={dockOpen}
							cwd={cwd}
							fileRequest={dockFile}
							tabs={dockTabs}
							active={dockActive}
							tasks={liveTasks}
							checkpoints={snapshot?.checkpoints ?? []}
							checkpointsBusy={busy || (snapshot?.streaming ?? false)}
							onSelect={(tab) => (tab === null ? setDockActive(null) : openDockTab(tab))}
							onCloseTab={closeDockTab}
							onCancelTask={(id) => void api.agentCancelTask(id)}
							onRestoreCheckpoint={setRestoreTarget}
							onCloseDock={() => setDockOpenStored(false)}
						/>
					</div>
				</aside>
			</div>
			{/* Outside the chrome row: a modal belongs to the window, not to the pane
			    that raised it, and both the transcript and the dock raise this one. */}
			<CheckpointRestoreDialog
				checkpoint={restoreTarget}
				onClose={() => setRestoreTarget(null)}
				onRestored={checkpointRestored}
				onError={setError}
			/>
			<AutomaticUpdateDialog deferred={restoreTarget !== null} />
		</div>
	);
}
