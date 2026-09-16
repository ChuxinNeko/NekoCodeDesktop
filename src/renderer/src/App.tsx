import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSnapshot, ExecutionMode, ThinkingLevel, ThreadSummary } from "../../shared/agent";
import { api, errorMessage } from "./api";
import { AutomationsPage } from "./components/automations/AutomationsPage";
import { BrowserPanel } from "./components/BrowserPanel";
import { ChatView } from "./components/ChatView";
import { PullRequestsPage } from "./components/pullRequests/PullRequestsPage";
import { ReviewPanel } from "./components/ReviewPanel";
import { SettingsPage } from "./components/settings/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { useAppearanceVariables } from "./hooks/useAppearanceVariables";
import { useTheme } from "./hooks/useTheme";
import { DEFAULT_UI_DENSITY, type UiDensity } from "./lib/appDensity";
import { DEFAULT_CHAT_WIDTH, type ChatWidthMode } from "./lib/chatWidth";
import { cn } from "./lib/utils";
import { CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME } from "./components/chat/composerPickerStyles";

const PROJECT_STORAGE_KEY = "nekocode:project-cwd";
const DENSITY_STORAGE_KEY = "nekocode:density";
const CHAT_WIDTH_STORAGE_KEY = "nekocode:chat-width";
const BROWSER_WIDTH_STORAGE_KEY = "nekocode:browser-dock-width";
const DEFAULT_BROWSER_WIDTH = 460;
const MIN_BROWSER_WIDTH = 320;
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
	const [cwd, setCwd] = useState<string | null>(() => readStored(PROJECT_STORAGE_KEY));
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
	const [threads, setThreads] = useState<ThreadSummary[]>([]);
	const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [browserOpen, setBrowserOpen] = useState(false);
	const [browserWidth, setBrowserWidth] = useState(() => {
		const stored = Number(readStored(BROWSER_WIDTH_STORAGE_KEY));
		return Number.isFinite(stored) && stored >= MIN_BROWSER_WIDTH
			? stored
			: DEFAULT_BROWSER_WIDTH;
	});
	const dockDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

	useEffect(() => {
		const unsubscribe = api.onAgentSnapshot((next) => {
			setSnapshot(next);
			setError(next.error ?? null);
		});
		return unsubscribe;
	}, []);

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

	// Load threads whenever the project directory changes.
	useEffect(() => {
		if (!cwd) {
			setThreads([]);
			return;
		}
		let cancelled = false;
		api
			.agentListThreads(cwd)
			.then((list) => {
				if (!cancelled) setThreads(list);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [cwd]);

	const refreshThreads = useMemo(
		() => async (target: string) => {
			try {
				setThreads(await api.agentListThreads(target));
			} catch (cause) {
				setError(errorMessage(cause));
			}
		},
		[],
	);

	const pickProject = async () => {
		const picked = await api.pickDirectory();
		if (!picked) return;
		setCwd(picked);
		writeStored(PROJECT_STORAGE_KEY, picked);
		setSnapshot(null);
	};

	const openThread = async (thread: ThreadSummary) => {
		if (!cwd) return;
		setBusy(true);
		try {
			setSnapshot(await api.agentOpen({ cwd, sessionFile: thread.sessionFile }));
			setView("chat");
			setError(null);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const createThread = async () => {
		if (!cwd) return;
		setBusy(true);
		try {
			const next = await api.agentCreate(cwd);
			setSnapshot(next);
			setView("chat");
			setError(null);
			await refreshThreads(cwd);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const send = async (text: string) => {
		try {
			const result = await api.agentSend({ text });
			if (!result.accepted) {
				setError(result.error);
				return;
			}
			if (result.action === "new-thread") await createThread();
			if (result.action === "open-terminal") setTerminalOpen(true);
			if (cwd) await refreshThreads(cwd);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const setModel = async (modelKey: string) => {
		try {
			setSnapshot(await api.agentSetModel(modelKey));
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const setThinking = async (level: ThinkingLevel) => {
		try {
			setSnapshot(await api.agentSetThinking(level));
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const setMode = async (mode: ExecutionMode) => {
		try {
			setSnapshot(await api.agentSetMode(mode));
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const startDockDrag = (event: React.MouseEvent) => {
		event.preventDefault();
		dockDragRef.current = { startX: event.clientX, startWidth: browserWidth };
		const onMove = (moveEvent: MouseEvent) => {
			const drag = dockDragRef.current;
			if (!drag) return;
			const maxWidth = Math.max(
				MIN_BROWSER_WIDTH,
				window.innerWidth - MIN_CHAT_WIDTH,
			);
			const next = Math.min(
				maxWidth,
				Math.max(MIN_BROWSER_WIDTH, drag.startWidth - (moveEvent.clientX - drag.startX)),
			);
			setBrowserWidth(next);
		};
		const onUp = () => {
			dockDragRef.current = null;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			setBrowserWidth((width) => {
				writeStored(BROWSER_WIDTH_STORAGE_KEY, String(width));
				return width;
			});
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	return (
		<div className="flex h-dvh min-h-0 w-full overflow-hidden text-foreground">
			<Sidebar
				cwd={cwd}
				threads={threads}
				activeThreadId={snapshot?.thread.id ?? null}
				view={view}
				busy={busy}
				theme={theme}
				resolvedTheme={resolvedTheme}
				browserOpen={browserOpen}
				onPickProject={pickProject}
				onNewThread={createThread}
				onOpenThread={openThread}
				onSelectView={setView}
				onToggleBrowser={() => setBrowserOpen((open) => !open)}
				onToggleTheme={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
			/>
			<main
				className={cn(
					CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
					"flex min-h-0 min-w-0 flex-1 flex-col",
				)}
			>
				{view === "settings" ? (
					<SettingsPage onClose={() => setView("chat")} />
				) : view === "review" ? (
					<ReviewPanel cwd={cwd} onClose={() => setView("chat")} />
				) : view === "pull-requests" ? (
					<PullRequestsPage cwd={cwd} onClose={() => setView("chat")} />
				) : view === "automations" ? (
					<AutomationsPage cwd={cwd} onClose={() => setView("chat")} />
				) : (
					<ChatView
						cwd={cwd}
						snapshot={snapshot}
						busy={busy}
						error={error}
						terminalOpen={terminalOpen}
						browserOpen={browserOpen}
						onPickProject={pickProject}
						onSend={send}
						onAbort={() => void api.agentAbort()}
						onSetModel={setModel}
						onSetThinking={setThinking}
						onSetMode={setMode}
						onOpenReview={() => setView("review")}
						onToggleTerminal={() => setTerminalOpen((open) => !open)}
						onToggleBrowser={() => setBrowserOpen((open) => !open)}
						onDismissError={() => setError(null)}
					/>
				)}
				{terminalOpen ? (
					<TerminalPanel cwd={cwd} onClose={() => setTerminalOpen(false)} />
				) : null}
			</main>
			{browserOpen ? (
				<>
					<div
						aria-hidden="true"
						className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
						onMouseDown={startDockDrag}
					/>
					<div
						className="flex min-h-0 shrink-0 flex-col border-l border-[color:var(--app-surface-divider)]"
						style={{ width: browserWidth }}
					>
						<BrowserPanel onClose={() => setBrowserOpen(false)} />
					</div>
				</>
			) : null}
		</div>
	);
}
