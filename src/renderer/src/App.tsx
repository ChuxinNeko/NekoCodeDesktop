import type { FusionConfig } from "../../shared/fusion";
import { elementSelectionText, type BrowserPreviewRequest, type ComposerInsertion } from "../../shared/browser";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { mentionToken } from "../../shared/mentions";
import { mergeActiveSession, workspaceKey } from "../../shared/sessions";
import { api, errorMessage } from "./api";
import { AutomationsPage } from "./components/automations/AutomationsPage";
import { TasksPage } from "./components/tasks/TasksPage";
import { TeamPage } from "./components/team/TeamPage";
import { activeTaskCount } from "../../shared/task-board";
import { useTaskBoard } from "./hooks/useTaskBoard";
import { AcpChatView } from "./components/agents/AcpChatView";
import { WorkspacePicker, workspaceName } from "./components/agents/WorkspacePicker";
import { NEKO_LOCAL_WORKSPACE } from "../../shared/acp";
import { useAcpWorkspace } from "./hooks/useAcpWorkspace";
import { useAcpPanes } from "./hooks/useAcpPanes";
import { ChatView } from "./components/ChatView";
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog";
import {
	RightDock,
	taskTabId,
	type DockTabId,
	type DockTool,
} from "./components/dock/RightDock";
import { GitHubPage } from "./components/github/GitHubPage";
import { ReviewPanel } from "./components/ReviewPanel";
import type { TurnDiffRequest } from "./lib/turnChanges";
import { SettingsPage, type SettingsSectionId } from "./components/settings/SettingsPage";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary";
import { AutomaticUpdateDialog } from "./components/updates/UpdateDialog";
import { useHostDirectoryPicker } from "./components/HostDirectoryPicker";
import { Sidebar } from "./components/Sidebar";
import { AppRail } from "./components/AppRail";
import { TerminalPanel } from "./components/TerminalPanel";
import { TitleBar } from "./components/TitleBar";
import { ChatSlot, createChatHost } from "./components/ChatSlot";
import { CommunityAmbient, CommunityBackground } from "./components/CommunityBackground";
import { WallpaperBackdrop } from "./components/WallpaperBackdrop";
import { SplitGrid } from "./components/SplitGrid";
import { useSplitPanes, type PaneSlot } from "./hooks/useSplitPanes";
import { startResizeDrag } from "./lib/resizeDrag";
import { startSessionDrag, type DraggedSession } from "./lib/sessionDrag";
import type { DropPlan } from "./lib/splitLayout";
import { DragHandleIcon, Maximize2, XIcon } from "./lib/icons";
import { IconButton } from "./components/ui/icon-button";
import { useShortcutHandlers } from "./hooks/useShortcuts";
import { useLayoutMode } from "./hooks/useLayoutMode";
import type { InlineEditRequest } from "./components/ide/EditorArea";
import { Spinner } from "./components/ui/spinner";
import { useAppearancePreferences } from "./hooks/useAppearancePreferences";
import { useAppearanceVariables } from "./hooks/useAppearanceVariables";
import { useSessions } from "./hooks/useSessions";
import { useTheme } from "./hooks/useTheme";
import { cn } from "./lib/utils";
import { shareStructure } from "./lib/structural-share";
import { LinkOpenerContext, openLinkExternally } from "./lib/webSources";
import { CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME } from "./components/chat/composerPickerStyles";
import { useTranslation } from "./i18n";

/**
 * The IDE layout, Monaco included, loads only when someone first switches to
 * it: several megabytes nobody using the Agent layout should pay for.
 */
const IdeLayout = lazy(() => import("./components/ide/IdeLayout"));

const PROJECT_STORAGE_KEY = "nekocode:project-cwd";
const WORKSPACES_STORAGE_KEY = "nekocode:workspaces";
/** Workspace keys removed from the sidebar; their sessions stay on disk. */
const HIDDEN_WORKSPACES_STORAGE_KEY = "nekocode:hidden-workspaces";
const DOCK_WIDTH_STORAGE_KEY = "nekocode:dock-width";
const DOCK_OPEN_STORAGE_KEY = "nekocode:dock-open";
const SIDEBAR_OPEN_STORAGE_KEY = "nekocode:sidebar-open";
/** NekoLocal or the id of an external agent; see the workspace picker. */
const AGENT_WORKSPACE_STORAGE_KEY = "nekocode:agent-workspace";
const IDE_SIDE_OPEN_STORAGE_KEY = "nekocode:ide-side-open";
const IDE_CHAT_OPEN_STORAGE_KEY = "nekocode:ide-chat-open";
const DEFAULT_DOCK_WIDTH = 460;
const MIN_DOCK_WIDTH = 320;
const MIN_CHAT_WIDTH = 480;

export type WorkspaceView = "chat" | "team" | "tasks" | "review" | "pull-requests" | "automations" | "settings";

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function readStoredPaths(key: string): string[] {
	try {
		const value: unknown = JSON.parse(readStored(key) ?? "[]");
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) : [];
	} catch {
		return [];
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
	const { t } = useTranslation();
	const { resolvedTheme, setTheme } = useTheme();
	const browserAvailable = api.runtime !== "web";
	const pickDirectory = useHostDirectoryPicker();
	// Fall back to the home directory rather than to "no project": the welcome
	// screen is usable immediately, and the folder chip is right there to change.
	const [cwd, setCwd] = useState<string | null>(
		() => readStored(PROJECT_STORAGE_KEY) ?? (api.homeDir || null),
	);
	const { preferences: appearance } = useAppearancePreferences();

	useAppearanceVariables({
		density: appearance.density,
		chatWidth: appearance.chatWidth,
		chatFontSizePx: appearance.fontSizePx,
		chatCodeFontSizePx: appearance.codeFontSizePx,
		terminalFontSizePx: appearance.terminalFontSizePx,
	});

	const [view, setView] = useState<WorkspaceView>("chat");
	/** The settings section to land on — set when a shortcut elsewhere opens settings. */
	const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined);
	const selectView = (next: WorkspaceView) => {
		if (next === "settings") setSettingsSection(undefined);
		setView(next);
	};
	const sessions = useSessions();
	const taskBoard = useTaskBoard();
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
	const [workspaces, setWorkspaces] = useState<string[]>(() => readStoredPaths(WORKSPACES_STORAGE_KEY));
	const [hiddenWorkspaces, setHiddenWorkspaces] = useState<string[]>(() => readStoredPaths(HIDDEN_WORKSPACES_STORAGE_KEY));
	const hiddenWorkspacesRef = useRef(hiddenWorkspaces);
	hiddenWorkspacesRef.current = hiddenWorkspaces;
	const updateHiddenWorkspaces = (update: (previous: string[]) => string[]) =>
		setHiddenWorkspaces((previous) => {
			const next = update(previous);
			if (next === previous) return previous;
			writeStored(HIDDEN_WORKSPACES_STORAGE_KEY, JSON.stringify(next));
			return next;
		});
	const listWorkspace = (path: string) =>
		setWorkspaces((previous) => {
			if (previous.some((entry) => workspaceKey(entry) === workspaceKey(path))) return previous;
			const next = [...previous, path];
			writeStored(WORKSPACES_STORAGE_KEY, JSON.stringify(next));
			return next;
		});
	/** Back in the sidebar: the user picked this folder or started work in it. */
	const revealWorkspace = (path: string) => {
		const key = workspaceKey(path);
		updateHiddenWorkspaces((previous) => (previous.includes(key) ? previous.filter((entry) => entry !== key) : previous));
		listWorkspace(path);
	};
	/** Off the sidebar, sessions and all, until it is picked again; nothing on disk is touched. */
	const removeWorkspace = (path: string) => {
		const key = workspaceKey(path);
		setWorkspaces((previous) => {
			const next = previous.filter((entry) => workspaceKey(entry) !== key);
			writeStored(WORKSPACES_STORAGE_KEY, JSON.stringify(next));
			return next;
		});
		updateHiddenWorkspaces((previous) => (previous.includes(key) ? previous : [...previous, key]));
	};
	// A directory the app lands in — a restore, a task opened from the board —
	// joins the list, unless the user removed it.
	useEffect(() => {
		if (cwd && !hiddenWorkspacesRef.current.includes(workspaceKey(cwd))) listWorkspace(cwd);
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
	const openSessionRef = useRef<(session: Pick<SessionSummary, "cwd" | "sessionFile">) => Promise<void>>(async () => undefined);
	const selectSessionRef = useRef<(session: DraggedSession) => Promise<void>>(async () => undefined);
	/**
	 * The conversation on screen, whichever agent it is with. An ACP one goes by
	 * its sidebar row key, which is what the split panes and the drag carry.
	 */
	const selected: DraggedSession | null = acpActive
		? acp.activeRowId && acp.snapshot
			? { id: acp.activeRowId, cwd: acp.snapshot.cwd, sessionFile: acp.activeRowId, agentId: acp.snapshot.agentId }
			: null
		: snapshot
			? { id: snapshot.session.id, cwd: snapshot.session.cwd, sessionFile: snapshot.session.sessionFile }
			: null;
	/** Up to four sessions side by side; see useSplitPanes. Opens through a ref, as `selectSession` comes later. */
	const openPaneSession = useCallback((session: DraggedSession) => selectSessionRef.current(session), []);
	const panes = useSplitPanes({
		enabled: api.runtime === "electron",
		active: snapshot,
		selected,
		open: openPaneSession,
	});
	// External agents' conversations in panes beside the selected one.
	const acpPanes = useAcpPanes(
		panes.slots.flatMap((slot) => {
			if (!slot.session?.agentId || (!panes.split && slot.leaving === undefined)) return [];
			const live = acp.liveId(slot.session.id);
			return live ? [live] : [];
		}),
	);
	// A pane's conversation that is not open — dropped in from the agent's
	// history, or closed as idle while it sat there — is opened again, without
	// being selected.
	const unopenedPanes = panes.split
		? panes.live.flatMap((slot) => (slot.session?.agentId && !acp.liveId(slot.session.id) ? [slot.session.id] : []))
		: [];
	const unopenedKey = unopenedPanes.join("\n");
	useEffect(() => {
		for (const id of unopenedPanes) void acp.ensureLive(id);
	}, [unopenedKey, acp.rows.length]);
	// An agent switched off or removed takes its panes with it, one at a time.
	const orphanPane = panes.split
		? panes.live.find(
				(slot) =>
					slot.session?.agentId &&
					acp.agents.length > 0 &&
					!acp.agents.some((agent) => agent.id === slot.session?.agentId && agent.enabled),
			)
		: undefined;
	useEffect(() => {
		if (orphanPane?.session) panes.forget(orphanPane.session.id);
	}, [orphanPane?.key]);
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
		() => {
			const stored = readStored(DOCK_OPEN_STORAGE_KEY);
			return stored === "1" || (stored === null && window.innerWidth >= 1100);
		},
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
	const [dockDiff, setDockDiff] = useState<TurnDiffRequest | null>(null);
	const [dockWidth, setDockWidth] = useState(() => {
		const stored = Number(readStored(DOCK_WIDTH_STORAGE_KEY));
		return Number.isFinite(stored) && stored >= MIN_DOCK_WIDTH
			? stored
			: DEFAULT_DOCK_WIDTH;
	});
	// Mid-drag the width goes straight to these two, not through state: a render
	// of the whole app per pointer move is what made the drag trail the cursor.
	const dockAsideRef = useRef<HTMLElement>(null);
	const dockInnerRef = useRef<HTMLDivElement>(null);
	/** The width transition is for opening and closing; under a drag it lags and gaps. */
	const [dockResizing, setDockResizing] = useState(false);

	// Agent or IDE. The IDE is a desktop feature: the WebUI and the phone app
	// never offer it.
	const { layoutMode, setLayoutMode } = useLayoutMode();
	const ideVisible = layoutMode === "ide" && view === "chat";
	/** Mounted on first use and then kept, hidden, so its tabs and edits survive switching back. */
	const [ideMounted, setIdeMounted] = useState(layoutMode === "ide");
	useEffect(() => {
		if (layoutMode === "ide") setIdeMounted(true);
	}, [layoutMode]);
	const [ideSideOpen, setIdeSideOpen] = useState(() => readStored(IDE_SIDE_OPEN_STORAGE_KEY) !== "0");
	const [ideChatOpen, setIdeChatOpen] = useState(() => readStored(IDE_CHAT_OPEN_STORAGE_KEY) !== "0");
	const setIdeSideOpenStored = (open: boolean) => {
		setIdeSideOpen(open);
		writeStored(IDE_SIDE_OPEN_STORAGE_KEY, open ? "1" : "0");
	};
	const setIdeChatOpenStored = (open: boolean) => {
		setIdeChatOpen(open);
		writeStored(IDE_CHAT_OPEN_STORAGE_KEY, open ? "1" : "0");
	};
	/** A file the conversation asked the IDE to open; the nonce re-raises the same path. */
	const [ideOpenFile, setIdeOpenFile] = useState<{ path: string; nonce: number } | null>(null);
	/**
	 * Each chat pane is rendered once, into its host, and shown by whichever
	 * layout is active: the Agent layout's grid, or the IDE's chat column for
	 * the focused pane.
	 */
	const chatHosts = useRef(new Map<string, HTMLElement>());
	const hostFor = (key: string): HTMLElement => {
		let host = chatHosts.current.get(key);
		if (!host) chatHosts.current.set(key, (host = createChatHost()));
		return host;
	};

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
		if (layoutMode === "ide") {
			setIdeOpenFile({ path, nonce: Date.now() });
			return;
		}
		setDockFile({ path, nonce: Date.now() });
		openDockTab("files");
	};

	// A file request names a path inside one project; a project switch retires it.
	useEffect(() => {
		setDockFile(null);
		setDockDiff(null);
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
		if (tab === "diff") setDockDiff(null);
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


	// A session that has just been started is not on disk yet, so the list from
	// main does not have it. Joining its snapshot in is what puts the row —
	// placeholder title and running dot — in the sidebar from the first prompt.
	const sessionRows = useMemo(
		() => mergeActiveSession(sessions.sessions, snapshot?.session),
		[sessions.sessions, snapshot?.session],
	);
	/** NekoLocal's sessions and every enabled agent's, grouped by project in one list. */
	const allRows = useMemo(() => [...sessionRows, ...acp.rows], [sessionRows, acp.rows]);

	useEffect(() => {
		const unsubscribe = api.onAgentSnapshot((next) => {
			showSnapshot(next);
			setError(next?.error ?? null);
		});
		return unsubscribe;
	}, []);

	// Only the visible agent owns the project path. NekoLocal keeps streaming
	// while an ACP conversation is open; its background snapshots must not move
	// that conversation (or its new-session warmup) back to NekoLocal's folder.
	// Reconcile on returning to NekoLocal too, even if it has stopped streaming.
	const localSessionCwd = snapshot?.session.cwd;
	useEffect(() => {
		if (acpActive || !localSessionCwd) return;
		setCwd(localSessionCwd);
		writeStored(PROJECT_STORAGE_KEY, localSessionCwd);
	}, [acpActive, localSessionCwd]);

	useEffect(() => api.onAgentDefaults(setDefaults), []);

	// Clicking a finished task's notification opens it. Routed through the ref
	// because the subscription outlives the render that made `openSession`.
	useEffect(() => api.onRevealSession((session) => void openSessionRef.current(session)), []);

	// A link in an answer opens as a tab in the dock's browser, beside the chat
	// it came from. The IDE layout has no dock on screen to show it in, and the
	// WebUI has no in-app browser, so there it goes to the system browser.
	const layoutModeRef = useRef(layoutMode);
	layoutModeRef.current = layoutMode;
	const openLink = useCallback((url: string) => {
		if (!browserAvailable || layoutModeRef.current === "ide") {
			openLinkExternally(url);
			return;
		}
		const scope = currentPreviewScope.current;
		setBrowserPreview({ id: crypto.randomUUID(), sessionId: scope.sessionId ?? "", cwd: scope.cwd ?? "", url, kind: "link" });
		setDockTabs((tabs) => (tabs.includes("browser") ? tabs : [...tabs, "browser"]));
		setDockActive("browser");
		setDockOpen(true);
		writeStored(DOCK_OPEN_STORAGE_KEY, "1");
	}, []);

	// The agent opening a remote desktop brings it on screen, as its browser does:
	// the user should see a machine being operated, not find out afterwards.
	const knownDesktops = useRef(new Set<string>());
	useEffect(
		() =>
			api.onDesktopState((states) => {
				for (const state of states) {
					if (state.phase === "closed") {
						knownDesktops.current.delete(state.hostId);
						continue;
					}
					if (knownDesktops.current.has(state.hostId)) continue;
					knownDesktops.current.add(state.hostId);
					if (state.controller === "agent") openDockTab("desktop");
				}
				for (const hostId of [...knownDesktops.current])
					if (!states.some((state) => state.hostId === hostId)) knownDesktops.current.delete(hostId);
			}),
		[],
	);

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
		revealWorkspace(path);
		setCwd(path);
		writeStored(PROJECT_STORAGE_KEY, path);
		acp.startNew(path);
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

	/** Open an agent's conversation, making that agent the workspace. */
	const openAcpSession = async (row: DraggedSession) => {
		if (!row.agentId) return;
		if (row.cwd) {
			setCwd(row.cwd);
			writeStored(PROJECT_STORAGE_KEY, row.cwd);
		}
		// In the same update as the open: the agent being left must not see the
		// new directory on its own and start a fresh conversation there.
		setWorkspace(row.agentId);
		await acp.open(row);
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
	const openSession = async (session: Pick<SessionSummary, "cwd" | "sessionFile">) => {
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

	/**
	 * Put any conversation on screen — NekoLocal's or an agent's — switching the
	 * workspace to whichever it belongs to. The sidebar and the split panes
	 * share it, since both hold the two kinds together.
	 */
	const selectSession = async (session: DraggedSession) => {
		if (session.agentId) return openAcpSession(session);
		if (snapshot?.session.id !== session.id) await openSession(session);
		// Only once it is open: until then the workspace still shows the one being left.
		setWorkspace(NEKO_LOCAL_WORKSPACE);
	};
	selectSessionRef.current = selectSession;

	/** A sidebar row: a conversation already in a split pane is focused there. */
	const openRow = (row: SessionSummary) => {
		const pane = panes.split ? panes.live.find((slot) => slot.session?.id === row.id) : undefined;
		if (pane) {
			setView("chat");
			panes.focus(pane.key);
			return;
		}
		void selectSession(row);
	};

	/**
	 * Branch at a reply and go to the branch — the same arrival as opening a
	 * session from the sidebar, which is where the original stays waiting.
	 */
	const forkSession = async (cellId: string, title = snapshot?.session.title) => {
		const seq = ++transitionSeq.current;
		try {
			const next = await api.agentFork({ cellId, title: title ? t("message.branchTitle", { title }) : undefined });
			if (!next || seq !== transitionSeq.current) return;
			setCwd(next.session.cwd);
			writeStored(PROJECT_STORAGE_KEY, next.session.cwd);
			showSnapshot(next);
			setView("chat");
			setError(null);
		} catch (cause) {
			if (seq === transitionSeq.current) setError(errorMessage(cause));
		}
	};

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
			revealWorkspace(next.session.cwd);
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

	const send = async (request: SendPromptRequest, propagateFailure = false) => {
		try {
			const result = await api.agentSend(request);
			if (!result.accepted) {
				throw new Error(result.error);
			}
			if (result.action === "new-session") await createSession();
			if (result.action === "open-terminal") setTerminalOpen(true);
			// The list refreshes itself: main pushes `sessionsChanged` once the
			// prompt names the session and again when the run settles.
		} catch (cause) {
			setError(errorMessage(cause));
			if (propagateFailure) throw cause;
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
	const startBackgroundTask = async (text: string, target = snapshot?.session.cwd ?? cwd) => {
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

	/** Put text at the end of the composer's draft — the IDE's "Add to chat". */
	const addToChat = (text: string) => {
		setComposerInsertion((pending) => ({ id: crypto.randomUUID(), text: (pending?.text ?? "") + text }));
	};

	/**
	 * Ctrl+K in the editor: the selected lines and the instruction go to the
	 * agent as a prompt. The file is referenced with `@`, so the agent gets it
	 * whole, and the lines are quoted so it knows which part is meant.
	 */
	const inlineEdit = async (request: InlineEditRequest) => {
		const lines =
			request.startLine === request.endLine ? `第 ${request.startLine} 行` : `第 ${request.startLine}-${request.endLine} 行`;
		const fence = request.selection.includes("```") ? "````" : "```";
		const language = request.language === "plaintext" ? "" : request.language;
		const text =
			`修改 ${mentionToken({ kind: "file", path: request.relPath })} 的${lines}：${request.instruction}\n\n` +
			`这一段现在是：\n${fence}${language}\n${request.selection.replace(/\n+$/, "")}\n${fence}\n\n` +
			"只改这一段需要改的地方（相关的导入等可以一并调整），改完用一两句话说明改了什么。";
		if (acpActive) {
			const target = acp.snapshot?.cwd ?? cwd;
			if (target) await acp.send(target, text);
			return;
		}
		if (snapshot) await send({ text });
		else await startSession({ text });
	};

	// An agent run ending is when files and git state are likeliest to have
	// moved; the IDE refreshes its tree and source control on this.
	const streamingNow = acpActive ? (acp.snapshot?.streaming ?? false) : (snapshot?.streaming ?? false);
	const [agentActivity, setAgentActivity] = useState(0);
	const wasStreaming = useRef(false);
	useEffect(() => {
		if (wasStreaming.current && !streamingNow) setAgentActivity((value) => value + 1);
		wasStreaming.current = streamingNow;
	}, [streamingNow]);

	/**
	 * One pane's conversation.
	 *
	 * Main acts on the selected session only, and the focused pane is that
	 * session; a pane that is not focused first becomes it — `panes.ready` —
	 * before anything it asks for goes out. Alone in the chat area, the pane is
	 * the chat view as it has always been.
	 */
	const renderPaneChat = (slot: PaneSlot) => {
		const focused = slot.leaving === undefined && slot.key === panes.focused;
		const split = panes.split;
		if (slot.session?.agentId && (split || slot.leaving !== undefined)) return renderAcpPane(slot, slot.session, focused);
		if (acpActive && acp.agent && focused && !split) {
			return (
				<AcpChatView
					insertion={composerInsertion}
					onInsertionConsumed={(id) => setComposerInsertion((current) => (current?.id === id ? null : current))}
					agent={acp.agent}
					workspacePicker={workspacePicker}
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
			);
		}
		const paneSnapshot = panes.snapshotFor(slot);
		const sessionCwd = paneSnapshot?.session.cwd ?? cwd;
		/** Run an action once this pane's session is the selected one. */
		const inPane =
			<A extends unknown[]>(action: (...args: A) => unknown) =>
			(...args: A): void => {
				if (!split) void action(...args);
				else void panes.ready(slot.key).then(() => action(...args));
			};
		// Interactive cards must await selection and host acceptance so failures
		// appear in the card instead of being reported as successful submissions.
		const inPaneInteractive =
			<A extends unknown[]>(action: (...args: A) => unknown) =>
			async (...args: A): Promise<void> => {
				if (split) await panes.ready(slot.key);
				await action(...args);
			};
		return (
			<ChatView
				workspacePicker={split ? undefined : workspacePicker}
				onGoalAction={async (action) => {
					await panes.ready(slot.key);
					const next = await api.agentGoal(action);
					if (next) showSnapshot(next);
				}}
				loadMentions={(query) => api.agentMentions(query, sessionCwd ?? undefined)}
				insertion={focused ? composerInsertion : null}
				onInsertionConsumed={(id) => setComposerInsertion((current) => current?.id === id ? null : current)}
				cwd={sessionCwd}
				snapshot={paneSnapshot}
				loadingSession={split && !paneSnapshot}
				earlierAvailable={focused && (paneSnapshot?.earlierCells ?? 0) > 0}
				loadingEarlier={focused && loadingEarlier}
				onLoadEarlier={() => void loadEarlier()}
				onLoadToolOutput={async (toolCallId, offset) => {
					await panes.ready(slot.key);
					return loadToolOutput(toolCallId, offset);
				}}
				defaults={defaults}
				busy={busy}
				error={focused ? error : null}
				terminalOpen={focused && terminalOpen}
				browserAvailable={browserAvailable}
				browserOpen={focused && dockOpen && dockActive === "browser"}
				onPickProject={pickProject}
				onSend={inPane(send)}
				onInteractiveSend={inPaneInteractive((request: SendPromptRequest) => send(request, true))}
				onSendBackground={inPane((text: string) => startBackgroundTask(text, sessionCwd))}
				// Stopping a run needs no selection: main can abort any live session.
				onAbort={() => void (split && paneSnapshot ? api.agentAbortTask(paneSnapshot.session.id) : api.agentAbort())}
				onStopCommand={paneSnapshot ? (id) => api.agentStopCommand(paneSnapshot.session.id, id) : undefined}
				onAnswerWorkflow={async (answer) => {
					await panes.ready(slot.key);
					return api.agentAnswerWorkflow(answer);
				}}
				onSetFusion={inPane(setFusion)}
				onSetModel={inPane(setModel)}
				onSetThinking={inPane(setThinking)}
				onSetMode={inPane(setMode)}
				onSetWorkMode={inPane(setWorkMode)}
				onOpenReview={layoutMode === "ide" ? undefined : inPane(async () => {
					try {
						const status = sessionCwd ? await api.gitStatus(sessionCwd) : null;
						// A missing Git executable is not evidence that this is a non-repository.
						openDockTab(!status || (status.gitAvailable && !status.isRepo) ? "checkpoints" : "review");
					} catch (cause) {
						setError(errorMessage(cause));
					}
				})}
				onToggleTerminal={inPane(() => setTerminalOpen((open) => !open))}
				onToggleBrowser={inPane(() => toggleDockTool("browser"))}
				onOpenTask={layoutMode === "ide" ? undefined : inPaneInteractive((taskId: string) => openDockTab(taskTabId(taskId)))}
				onOpenFile={inPaneInteractive(openDockFile)}
				onOpenDiff={layoutMode === "ide" ? undefined : inPane((checkpoint: CheckpointSummary, path: string) => {
					setDockDiff({ checkpoint, path, nonce: Date.now() });
					openDockTab("diff");
				})}
				onDismissError={() => setError(null)}
				onStartSession={startSession}
				onWorktreeReleased={() => sessions.refresh()}
				onWorktreeError={setError}
				onRestoreCheckpoint={inPane(setRestoreTarget)}
				onForkMessage={async (cellId) => {
					await panes.ready(slot.key);
					await forkSession(cellId, paneSnapshot?.session.title);
				}}
				onOpenCheckpoints={inPane(() => openDockTab("checkpoints"))}
				hideDockActions={layoutMode === "ide"}
				compactHeader={split && layoutMode === "agent"}
				headerActions={
					split && layoutMode === "agent" && slot.session ? (
						<PaneControls
							session={slot.session}
							title={paneSnapshot?.session.title ?? ""}
							onMaximize={() => panes.maximize(slot.key)}
							onClose={() => panes.close(slot.key)}
						/>
					) : undefined
				}
			/>
		);
	};

	/**
	 * An external agent's conversation in a split pane. Its actions name the
	 * session, so unlike a NekoLocal pane it acts without being selected first.
	 */
	const renderAcpPane = (slot: PaneSlot, session: DraggedSession, focused: boolean) => {
		const agent = acp.agents.find((entry) => entry.id === session.agentId);
		if (!agent) return null;
		const sessionId = acp.liveId(session.id);
		const paneSnapshot = sessionId
			? acp.snapshot?.id === sessionId
				? acp.snapshot
				: acpPanes.snapshot(sessionId)
			: null;
		const act = (action: (id: string) => Promise<unknown>) => {
			if (sessionId) acpPanes.run(sessionId, () => action(sessionId));
		};
		return (
			<AcpChatView
				agent={agent}
				insertion={focused ? composerInsertion : null}
				onInsertionConsumed={(id) => setComposerInsertion((current) => (current?.id === id ? null : current))}
				composerHeader={undefined}
				cwd={paneSnapshot?.cwd ?? session.cwd}
				error={sessionId ? acpPanes.error(sessionId) : null}
				historyError={null}
				loadingSession={!paneSnapshot}
				onAbort={() => act((id) => api.acpCancel(id))}
				onDismissError={() => {
					if (sessionId) acpPanes.dismissError(sessionId);
				}}
				onPickProject={pickProject}
				onRespondPermission={(requestId, optionId) =>
					act((id) => api.acpRespondPermission({ sessionId: id, requestId, optionId }))
				}
				onSend={(request) =>
					act((id) =>
						api.acpPrompt({ sessionId: id, text: request.text, ...(request.images?.length ? { images: request.images } : {}) }),
					)
				}
				onSetConfig={(configId, value) => act((id) => api.acpSetConfig({ sessionId: id, configId, value }))}
				snapshot={paneSnapshot}
				compactHeader={panes.split && layoutMode === "agent"}
				headerActions={
					panes.split && layoutMode === "agent" ? (
						<PaneControls
							session={session}
							title={paneSnapshot?.title ?? ""}
							onMaximize={() => panes.maximize(slot.key)}
							onClose={() => panes.close(slot.key)}
						/>
					) : undefined
				}
			/>
		);
	};

	// A pane that is gone takes its host with it.
	const slotKeys = panes.slots.map((slot) => slot.key).join(",");
	useEffect(() => {
		const keys = new Set(slotKeys.split(","));
		for (const key of [...chatHosts.current.keys()]) if (!keys.has(key)) chatHosts.current.delete(key);
	}, [slotKeys]);

	const dropSession = (session: DraggedSession, plan: DropPlan) => {
		// Onto the welcome screen, or the one pane already showing it: nothing to split.
		if (plan.order.length < 2) void selectSession(session);
		else panes.drop(session, plan);
	};

	const hideWorkspaceSidebar = view === "team" || view === "settings" || view === "pull-requests" || view === "review";

	const startDockDrag = (event: React.PointerEvent<HTMLElement>) => {
		setDockResizing(true);
		startResizeDrag(event, {
			axis: "x",
			sign: -1,
			initial: dockWidth,
			min: MIN_DOCK_WIDTH,
			max: () => window.innerWidth - 52 - (sidebarOpen && !hideWorkspaceSidebar ? 260 : 0) - 4 - MIN_CHAT_WIDTH,
			onFrame: (width) => {
				if (dockAsideRef.current) dockAsideRef.current.style.width = `${width}px`;
				if (dockInnerRef.current) dockInnerRef.current.style.width = `${width}px`;
			},
			onEnd: (width) => {
				setDockWidth(width);
				setDockResizing(false);
				writeStored(DOCK_WIDTH_STORAGE_KEY, String(width));
			},
		});
	};

	const focusComposer = () => {
		setView("chat");
		if (layoutMode === "ide") setIdeChatOpenStored(true);
		requestAnimationFrame(() => {
			const host = chatHosts.current.get(panes.focused);
			const composer = host?.querySelector<HTMLTextAreaElement>("textarea[data-chat-composer]");
			if (composer) composer.focus();
			else [...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-chat-composer]")]
				.find((input) => input.getClientRects().length && !input.closest("[inert], .layout-hidden"))?.focus();
		});
	};
	useShortcutHandlers({
		"app.newSession": () => {
			if (busy || !cwd) return false;
			setView("chat");
			if (acpActive) acp.startNew();
			else void createSession();
		},
		"app.openProject": () => { if (busy) return false; void pickProject(); },
		"app.settings": () => selectView("settings"),
		"app.shortcuts": () => { setSettingsSection("shortcuts"); setView("settings"); },
		"app.chat": () => selectView("chat"),
		"app.tasks": () => selectView("tasks"),
		"app.review": () => selectView("review"),
		"app.github": () => selectView("pull-requests"),
		"app.automations": () => selectView("automations"),
		"app.sidebar": () => {
			if (ideVisible) setIdeSideOpenStored(!ideSideOpen);
			else { setSidebarOpen(!sidebarOpen); writeStored(SIDEBAR_OPEN_STORAGE_KEY, sidebarOpen ? "0" : "1"); }
		},
		"app.dock": () => { if (ideVisible) setIdeChatOpenStored(!ideChatOpen); else setDockOpenStored(!dockOpen); },
		"app.focusComposer": focusComposer,
		"app.stop": () => {
			if (view !== "chat" || !streamingNow) return false;
			if (acpActive) acp.cancel();
			else void (panes.split && snapshot ? api.agentAbortTask(snapshot.session.id) : api.agentAbort()).catch((cause) => setError(errorMessage(cause)));
		},
		"app.layout": () => { if (api.runtime !== "electron") return false; setLayoutMode(layoutMode === "ide" ? "agent" : "ide"); setView("chat"); },
		"app.theme": () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
	});
	useShortcutHandlers({
		"agent.terminal": () => toggleDockTool("terminal"),
		"agent.browser": () => { if (!browserAvailable) return false; toggleDockTool("browser"); },
		"agent.files": () => toggleDockTool("files"),
		"agent.review": () => toggleDockTool("review"),
		"agent.checkpoints": () => toggleDockTool("checkpoints"),
		"agent.agentmap": () => toggleDockTool("agentmap"),
		"agent.desktop": () => { if (!browserAvailable) return false; toggleDockTool("desktop"); },
	}, view === "chat" && !ideVisible);

	return (
		<LinkOpenerContext.Provider value={openLink}>
		<div className="app-window-backdrop relative flex h-dvh min-h-0 w-full flex-col overflow-hidden text-foreground">
			<WallpaperBackdrop />
			<CommunityAmbient />
			<TitleBar
				onOpenTeam={() => selectView("team")}
				projectLabel={cwd ? projectLabel(cwd, api.homeDir) : null}
				sidebarOpen={ideVisible ? ideSideOpen : sidebarOpen}
				onToggleSidebar={() => {
					if (ideVisible) {
						setIdeSideOpenStored(!ideSideOpen);
						return;
					}
					setSidebarOpen((open) => {
						writeStored(SIDEBAR_OPEN_STORAGE_KEY, open ? "0" : "1");
						return !open;
					});
				}}
				dockOpen={ideVisible ? ideChatOpen : dockOpen}
				onToggleDock={() => (ideVisible ? setIdeChatOpenStored(!ideChatOpen) : setDockOpenStored(!dockOpen))}
			/>
			{/* Both layouts stay laid out, one over the other: hiding with visibility
			    rather than unmounting keeps the browser's webviews and the IDE's
			    editors alive across a switch. */}
			<div className="relative flex min-h-0 min-w-0 flex-1">
			<div
				inert={ideVisible}
				className={cn(
					"app-chrome-surface absolute inset-0 flex min-h-0 min-w-0 overflow-hidden",
					ideVisible && "layout-hidden",
				)}
			>
				<AppRail
					view={view}
					activeTasks={activeTaskCount(taskBoard)}
					resolvedTheme={resolvedTheme}
					browserAvailable={browserAvailable}
					browserOpen={dockOpen && dockActive === "browser"}
					onSelectView={(next) => {
						selectView(next);
						if (next === "chat") {
							setSidebarOpen(true);
							writeStored(SIDEBAR_OPEN_STORAGE_KEY, "1");
						}
					}}
					onToggleBrowser={() => toggleDockTool("browser")}
					onToggleTheme={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
				/>
				{sidebarOpen ? (
					<div className={hideWorkspaceSidebar ? "hidden" : "contents"}>
					<Sidebar
						cwd={cwd}
						workspaces={workspaces}
						hiddenWorkspaces={hiddenWorkspaces}
						onRemoveWorkspace={removeWorkspace}
						sessions={allRows}
						sessionsLoading={sessions.loading || acp.loading}
						agents={acp.agents}
						sessionsDraggable={api.runtime === "electron"}
						activeSessionId={selected?.id ?? null}
						streaming={streamingNow}
						view={view}
						busy={busy}
						onPickProject={pickProject}
						onNewSession={() => {
							if (!acpActive) return void createSession();
							acp.startNew();
							setView("chat");
						}}
						onNewWorkspaceSession={(path) => (acpActive ? switchProject(path) : void createSession(path))}
						onOpenSession={openRow}
						onRenameSession={(session, title) => {
							if (!session.agentId) void sessions.rename(session, title);
						}}
						onDeleteSession={async (session, deleteFromCli) => {
							if (session.agentId) {
								const removed = await acp.remove(session, deleteFromCli);
								if (removed) panes.forget(session.id);
								return removed;
							}
							await sessions.remove(session);
							panes.forget(session.id);
						}}
					/>
					</div>
				) : null}
				<main
					className={cn(
						CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
						"flex min-h-0 min-w-0 flex-1 flex-col",
						hideWorkspaceSidebar ? "rounded-l-xl" : !sidebarOpen && "rounded-tl-lg",
						dockOpen && "rounded-tr-lg",
					)}
				>
					{view === "chat" ? (
						<CommunityBackground
							empty={
								!panes.split &&
								(acpActive ? !acp.snapshot || acp.snapshot.cells.length === 0 : (snapshot?.cells.length ?? 0) === 0)
							}
						/>
					) : null}
					<ViewErrorBoundary resetKey={`${view}:${snapshot?.session.id ?? ""}`}>
					{view === "settings" ? (
						<SettingsPage
							onOpenTeam={() => selectView("team")}
							initialSection={settingsSection}
							key={settingsSection ?? "default"}
							onClose={() => setView("chat")}
							cwd={snapshot?.session.cwd ?? cwd}
							projects={workspaces}
						/>
					) : view === "team" ? (
						<TeamPage cwd={cwd} onOpenSession={(session) => { setWorkspace(NEKO_LOCAL_WORKSPACE); void openSession(session); }} />
					) : view === "tasks" ? (
						<TasksPage
							cwd={cwd}
							entries={taskBoard}
							workspaceName={workspaceName(NEKO_LOCAL_WORKSPACE, acp.agents)}
							onOpen={(entry) => {
								// Board tasks are NekoLocal sessions; an agent workspace on
								// screen would leave the opened one out of sight.
								if (acpActive) setWorkspace(NEKO_LOCAL_WORKSPACE);
								void openSession(entry);
							}}
							onOpenSettings={() => {
								setSettingsSection("general");
								setView("settings");
							}}
							onClose={() => setView("chat")}
						/>
					) : view === "review" ? (
						<ReviewPanel cwd={cwd} onClose={() => setView("chat")} />
					) : view === "pull-requests" ? (
						<GitHubPage cwd={cwd} onClose={() => setView("chat")} onOpenSettings={() => {
							setSettingsSection("github");
							setView("settings");
						}} />
					) : view === "automations" ? (
						<AutomationsPage cwd={cwd} onClose={() => setView("chat")} />
					) : (
						<SplitGrid
							slots={panes.slots}
							live={panes.live}
							focused={panes.focused}
							sessions={
								panes.split
									? panes.live.flatMap((slot) => (slot.session ? [slot.session.id] : []))
									: selected && !(acpActive && acp.snapshot?.pristine)
										? [selected.id]
										: []
							}
							acceptDrops={api.runtime === "electron"}
							renderPane={(slot) => <ChatSlot host={hostFor(slot.key)} active={!ideVisible} />}
							onFocus={panes.focus}
							onDrop={dropSession}
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
						className="dock-resize-handle w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
						onPointerDown={startDockDrag}
					/>
				) : null}
				{/* The dock stays mounted while collapsed so its width transition can
				    play and opened tools keep their state; `invisible` panes inside
				    keep webviews laid out rather than torn down. */}
				<aside
					ref={dockAsideRef}
					aria-hidden={!dockOpen}
					className={cn(
						"shrink-0 overflow-hidden",
						!dockResizing && "transition-[width] duration-200 ease-out",
						!dockOpen && "pointer-events-none",
					)}
					style={{ width: dockOpen ? dockWidth : 0 }}
				>
					<div
						ref={dockInnerRef}
						className="flex h-full flex-col overflow-hidden rounded-tl-lg border-l border-[color:var(--app-surface-divider)]"
						style={{ width: dockWidth }}
					>
						<RightDock
							browserPreview={browserPreview}
							visible={dockOpen}
							cwd={cwd}
							fileRequest={dockFile}
							diffRequest={dockDiff}
							tabs={dockTabs}
							active={dockActive}
							tasks={liveTasks}
							agentSnapshot={snapshot ?? null}
							onOpenTask={(taskId) => openDockTab(taskTabId(taskId))}
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
			{ideMounted ? (
				<div
					inert={!ideVisible}
					className={cn(
						"app-chrome-surface absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
						!ideVisible && "layout-hidden",
					)}
				>
					<Suspense
						fallback={
							<div className="flex flex-1 items-center justify-center">
								<Spinner className="size-4" />
							</div>
						}
					>
						<IdeLayout
							onOpenTeam={() => selectView("team")}
							cwd={cwd}
							visible={ideVisible}
							dark={resolvedTheme === "dark"}
							chat={<ChatSlot host={hostFor(panes.focused)} active={ideVisible} />}
							chatTitle={
								acpActive
									? null
									: snapshot?.session.titlePending
										? null
										: (snapshot?.session.title ?? null)
							}
							sideOpen={ideSideOpen}
							onSideOpenChange={setIdeSideOpenStored}
							chatOpen={ideChatOpen}
							onChatOpenChange={setIdeChatOpenStored}
							streaming={streamingNow}
							agentActivity={agentActivity}
							openFileRequest={ideOpenFile}
							sessions={allRows}
							activeSessionId={selected?.id ?? null}
							onOpenSession={openRow}
							onNewSession={() => {
								if (!acpActive) return void createSession();
								acp.startNew();
							}}
							onAddToChat={addToChat}
							onInlineEdit={inlineEdit}
							onOpenSettings={() => {
								setSettingsSection(undefined);
								setView("settings");
							}}
							onPickProject={() => void pickProject()}
						/>
					</Suspense>
				</div>
			) : null}
			</div>
			{/* Each pane rendered once and moved between layouts; see ChatSlot. */}
			{panes.slots.map((slot) =>
				createPortal(
					<ViewErrorBoundary resetKey={`chat:${panes.snapshotFor(slot)?.session.id ?? ""}`}>
						{renderPaneChat(slot)}
					</ViewErrorBoundary>,
					hostFor(slot.key),
					slot.key,
				),
			)}
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
		</LinkOpenerContext.Provider>
	);
}

/**
 * A split pane's own controls, at the end of its header: a grip to drag it to
 * another place in the layout, and the two ways out of the split.
 */
function PaneControls({
	session,
	title,
	onMaximize,
	onClose,
}: {
	session: DraggedSession;
	title: string;
	onMaximize: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div data-pane-control className="-mr-1 flex shrink-0 items-center gap-0.5 pl-1">
			<span
				aria-label={t("split.move")}
				className="flex size-6 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground active:cursor-grabbing"
				draggable
				onDragStart={(event) => startSessionDrag(event, session, title)}
				role="img"
				title={t("split.move")}
			>
				<DragHandleIcon className="size-3.5" />
			</span>
			<IconButton label={t("split.maximize")} onClick={onMaximize} title={t("split.maximize")}>
				<Maximize2 className="size-3.5" />
			</IconButton>
			<IconButton label={t("split.close")} onClick={onClose} title={t("split.close")}>
				<XIcon className="size-3.5" />
			</IconButton>
		</div>
	);
}
