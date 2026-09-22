import { PairingView } from "./PairingView";
import { useCallback, useEffect, useRef, useState } from "react";
import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { AgentDefaults, AgentSnapshot, SessionSummary } from "../../src/shared/agent";
import type { LanProject, LanTaskOptions } from "../../src/shared/lan";
import type { ComposerInsertion } from "../../src/shared/browser";
import { ChatView } from "../../src/renderer/src/components/ChatView";
import { SessionRow } from "../../src/renderer/src/components/sessions/SessionRow";
import { Button } from "../../src/renderer/src/components/ui/button";
import { Spinner } from "../../src/renderer/src/components/ui/spinner";
import { useTheme } from "../../src/renderer/src/hooks/useTheme";
import { useAppearanceVariables } from "../../src/renderer/src/hooks/useAppearanceVariables";
import { ArrowLeftIcon, PlusIcon, SettingsIcon, XIcon, FolderOpenIcon } from "../../src/renderer/src/lib/icons";
import { projectLabel } from "../../src/shared/paths";
import { LanError } from "./lan-client";
import { desktop, type TransportMode } from "./desktop-client";
import { PublicConnectionView } from "./PublicConnectionView";

const noop = () => undefined;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function MobileApp() {
	const { resolvedTheme, setTheme } = useTheme();
	useAppearanceVariables({ density: "comfortable", chatWidth: "full", chatFontSizePx: 14, terminalFontSizePx: 13 });
	const [ready, setReady] = useState(false);
	const [paired, setPaired] = useState(false);
	const [transport, setTransport] = useState<TransportMode | null>(null);
	const [online, setOnline] = useState(false);
	const [view, setView] = useState<"tasks" | "chat" | "settings">("tasks");
	const [projects, setProjects] = useState<LanProject[]>([]);
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [projectId, setProjectId] = useState("");
	const [id, setId] = useState<string | null>(null);
	const selected = useRef<string | null>(null);
	const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
	const [defaults, setDefaults] = useState<AgentDefaults | null>(null);
	const [projectSheet, setProjectSheet] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [insertion, setInsertion] = useState<ComposerInsertion | null>(null);
	/** Older turns exist before this transcript's first cell. */
	const [earlier, setEarlier] = useState(false);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const loadingEarlierRef = useRef(false);
	const [endpoint, setEndpoint] = useState("");
	const refreshing = useRef(false);
	const navigation = useRef({ view, projectSheet });
	navigation.current = { view, projectSheet };

	const clearSession = useCallback(() => {
		desktop.forgetSync();
		selected.current = null; setId(null); setSnapshot(null); setDefaults(null); setEarlier(false);
		setProjects([]); setSessions([]); setProjectId(""); setInsertion(null);
	}, []);

	const disconnected = useCallback((cause: unknown) => {
		setOnline(false);
		if (!(cause instanceof LanError) || cause.status !== 401) return;
		setError(cause.message);
		void (async () => {
			if (desktop.mode === "relay") {
				await desktop.suspend();
				if (desktop.hasLan) {
					await desktop.switch("lan");
					clearSession(); setTransport("lan"); setPaired(true);
				} else {
					await desktop.deactivate();
					setTransport(null); setPaired(false);
				}
			} else {
				await desktop.disconnect();
				clearSession(); setTransport(desktop.mode); setPaired(desktop.mode !== null);
			}
		})().catch((failure) => setError(message(failure)));
	}, [clearSession]);

	const refresh = useCallback(async () => {
		const marker = desktop.marker;
		if (!marker || refreshing.current || document.hidden) return;
		refreshing.current = true;
		try {
			const selectedId = selected.current;
			// Only pull the transcript while it is on screen. Backing out to the task
			// list used to leave it streaming in the background for the whole session.
			const wanted = selectedId && navigation.current.view === "chat" ? selectedId : null;
			// In parallel, not in turn: the two are independent, and over the relay a
			// serial pair spends a second full round trip on every tick.
			const [state, pulled] = await Promise.all([
				desktop.state(),
				wanted === null ? null : desktop.syncSnapshot(wanted).then(
					(synced) => ({ ok: true as const, synced }),
					(error: unknown) => ({ ok: false as const, error }),
				),
			]);
			if (desktop.marker !== marker) return;
			setSessions(state.tasks.map((task) => ({ ...task, sessionFile: "" })));
			setProjects(state.projects);
			setProjectId((previous) => state.projects.some((p) => p.id === previous) ? previous : state.projects[0]?.id ?? "");
			if (selectedId && !state.tasks.some((task) => task.id === selectedId)) {
				// The task is gone, so a transcript that failed to load is expected.
				desktop.forgetSync();
				selected.current = null; setId(null); setSnapshot(null); setEarlier(false); setView("tasks");
			} else if (pulled) {
				if (!pulled.ok) throw pulled.error;
				if (selected.current === wanted && desktop.marker === marker) {
					setSnapshot(pulled.synced.snapshot); setEarlier(pulled.synced.more);
				}
			}
			setOnline(true);
		} catch (cause) { if (desktop.marker === marker) disconnected(cause); }
		finally { refreshing.current = false; }
	}, [disconnected]);

	useEffect(() => {
		let alive = true;
		void desktop.restore().then((pairedDesktop) => {
			if (!alive) return;
			setPaired(pairedDesktop); setTransport(desktop.mode); setEndpoint(desktop.lanEndpoint); setReady(true); void refresh();
		});
		const timer = setInterval(() => { void refresh(); }, 1500);
		const resume = () => { if (!document.hidden) void refresh(); };
		document.addEventListener("visibilitychange", resume);
		const nativeListeners = Capacitor.isNativePlatform() ? [
			NativeApp.addListener("appStateChange", ({ isActive }) => { if (isActive) void refresh(); }),
			...(Capacitor.getPlatform() === "android" ? [NativeApp.addListener("backButton", () => {
				if (navigation.current.projectSheet) setProjectSheet(false);
				else if (navigation.current.view !== "tasks") setView("tasks");
				else void NativeApp.minimizeApp();
			})] : []),
		] : [];
		return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", resume); for (const listener of nativeListeners) void listener.then((handle) => handle.remove()); };
	}, [refresh]);

	useEffect(() => {
		if (!paired || !projectId || id) return;
		let cancelled = false;
		setDefaults(null);
		void desktop.defaults(projectId).then((next) => { if (!cancelled) setDefaults(next); })
			.catch((cause) => { if (!cancelled) setError(message(cause)); });
		return () => { cancelled = true; };
	}, [paired, projectId, id, transport]);

	/** The rest of a tool result the transcript only carries the head of. */
	const loadToolOutput = useCallback((toolCallId: string, offset: number) => {
		const target = selected.current;
		if (!target) return Promise.reject(new Error("会话已关闭"));
		return desktop.toolOutput(target, toolCallId, offset);
	}, []);

	const action = async (run: () => Promise<void>) => {
		if (busyRef.current) return;
		busyRef.current = true; setBusy(true); setError(null);
		try { await run(); }
		catch (cause) { setError(message(cause)); if (cause instanceof LanError && cause.status === 401) disconnected(cause); }
		finally { busyRef.current = false; setBusy(false); }
	};

	const open = (session: SessionSummary) => {
		// Navigate first, fetch second. The transcript is a round trip away, and
		// over the relay that is long enough for the tap to feel ignored.
		selected.current = session.id;
		setId(session.id); setSnapshot(null); setEarlier(false); setView("chat");
		void action(async () => {
			const next = await desktop.syncSnapshot(session.id);
			// A dropped fetch is not a dead end: the poll fills it in either way.
			if (selected.current !== session.id) return;
			setSnapshot(next.snapshot); setEarlier(next.more);
		});
	};

	/**
	 * Deliberately outside `action`: scrolling up is not a reason to lock the
	 * composer, and a failed page should leave the session usable.
	 */
	const loadEarlier = useCallback(() => {
		const target = selected.current;
		if (!target || loadingEarlierRef.current) return;
		loadingEarlierRef.current = true; setLoadingEarlier(true);
		void (async () => {
			try {
				const next = await desktop.loadEarlier(target);
				if (selected.current === target) { setSnapshot(next.snapshot); setEarlier(next.more); }
			} catch (cause) {
				setError(message(cause));
			} finally {
				loadingEarlierRef.current = false; setLoadingEarlier(false);
			}
		})();
	}, []);

	const newTask = (project?: string) => {
		selected.current = null; setId(null); setSnapshot(null); setInsertion(null); setError(null); setEarlier(false);
		if (project) setProjectId(project);
		setView("chat"); setProjectSheet(!project && projects.length !== 1);
	};

	const configure = (options: LanTaskOptions) => {
		if (selected.current) {
			const target = selected.current;
			void action(async () => { const next = await desktop.configure(target, options); if (selected.current === target) setSnapshot(next); });
		} else setDefaults((previous) => {
			if (!previous) return previous;
			const next = { ...previous, ...options };
			if (options.modelKey) {
				next.fusion = null;
				next.thinkingLevels = previous.models.find((model) => model.key === options.modelKey)?.thinkingLevels ?? ["off"];
				if (!next.thinkingLevels.includes(next.thinkingLevel)) next.thinkingLevel = next.thinkingLevels[0];
			}
			if (options.fusion) {
				next.modelKey = options.fusion.leadModelKey;
				next.thinkingLevel = options.fusion.leadThinkingLevel;
				next.thinkingLevels = previous.models.find((model) => model.key === next.modelKey)?.thinkingLevels ?? ["off"];
			}
			return next;
		});
	};

	const send = (text: string) => action(async () => {
		try {
			const target = selected.current;
			if (target) {
				const result = await desktop.send(target, text);
				if (!result.accepted) throw new Error(result.error);
				if (result.action === "new-session") { newTask(projects.find((p) => p.path === snapshot?.session.cwd)?.id); return; }
			} else {
				if (!defaults || !projectId) throw new Error("请先选择电脑授权的项目");
				const options: LanTaskOptions = {
					modelKey: defaults.fusion ? undefined : defaults.modelKey ?? undefined,
					fusion: defaults.fusion ?? undefined, thinkingLevel: defaults.thinkingLevel,
					mode: defaults.mode, workMode: defaults.workMode,
				};
				const result = await desktop.create(projectId, text, options);
				const next = await desktop.syncSnapshot(result.id);
				selected.current = result.id; setId(result.id);
				setSnapshot(next.snapshot); setEarlier(next.more);
				if (!result.accepted) throw new Error(result.error ?? "任务已创建，但未能开始执行");
			}
			// Not awaited: the prompt is already accepted, and holding `busy` over a
			// refresh is what kept the composer locked for the round trip after send.
			void refresh();
		} catch (cause) { setInsertion({ id: crypto.randomUUID(), text }); throw cause; }
	});

	const project = projects.find((p) => p.id === projectId);
	const groups = new Map<string, SessionSummary[]>();
	for (const task of sessions) groups.set(task.cwd, [...(groups.get(task.cwd) ?? []), task]);

	return <div className="mobile-shell flex flex-col bg-background text-foreground">
		{!ready ? <div className="flex flex-1 items-center justify-center"><Spinner /></div> : !paired ?
			<PairingView initialEndpoint={endpoint} busy={busy} error={error} onError={setError} onPair={(address, code, name) => action(async () => {
				await desktop.pairLan(address, code, name); clearSession(); setEndpoint(address); setTransport("lan"); setPaired(true); setView("tasks"); await refresh();
			})} onPublicConnect={async (device) => action(async () => {
				await desktop.selectRelay(device); clearSession(); setTransport("relay"); setPaired(true); setView("tasks"); await refresh();
			})} /> : <>
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				{view !== "tasks" && <Button aria-label="返回任务列表" size="icon" variant="ghost" onClick={() => setView("tasks")}><ArrowLeftIcon className="size-4" /></Button>}
				<div className="min-w-0 flex-1"><div className="text-sm font-medium">{view === "settings" ? "手机设置" : "NekoCode"}</div><div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className={`size-1.5 rounded-full ${online ? "bg-success" : "bg-warning"}`} />{online ? "桌面已连接" : "连接中断，正在重试"}</div></div>
				<Button aria-label="新建任务" size="icon" variant="ghost" disabled={busy || !online} onClick={() => newTask()}><PlusIcon className="size-4" /></Button>
				<Button aria-label="手机设置" size="icon" variant="ghost" onClick={() => setView("settings")}><SettingsIcon className="size-4" /></Button>
			</header>
			{error && view !== "chat" && <div role="alert" className="flex items-start gap-2 bg-destructive/6 px-4 py-3 text-xs text-destructive"><span className="min-w-0 flex-1 break-words">{error}</span><Button aria-label="关闭错误" size="icon-xs" variant="ghost" onClick={() => setError(null)}><XIcon className="size-3" /></Button></div>}
			{view === "tasks" && <div className="min-h-0 flex-1 overflow-y-auto p-3">
				<div className="mb-5 flex items-center justify-between px-2 pt-3"><h1 className="text-base font-medium">任务</h1><span className="text-xs text-muted-foreground">{sessions.filter((s) => s.running).length} 项运行中</span></div>
				{!sessions.length && <p className="px-2 py-10 text-center text-sm text-muted-foreground">{online ? "暂无任务，点击右上角 ＋ 创建" : "等待电脑连接…"}</p>}
				{[...groups].map(([cwd, tasks]) => <section key={cwd} className="mb-5"><div className="mb-2 flex items-center gap-2 px-2 text-xs text-muted-foreground"><FolderOpenIcon className="size-3.5" /><span className="truncate">{projectLabel(cwd)}</span></div>{tasks.map((task) => <SessionRow key={task.id} hideActions session={task} active={id === task.id} running={!!task.running} now={Date.now()} disabled={busy || !online} renaming={false} confirmingDelete={false} onOpen={() => { void open(task); }} onStartRename={noop} onRename={noop} onCancelRename={noop} onStartDelete={noop} onDelete={noop} onCancelDelete={noop} />)}</section>)}
			</div>}
			{view === "chat" && <main className="mobile-chat flex min-h-0 flex-1 flex-col">
				<ChatView key={id ?? `new:${projectId}`} mobile earlierAvailable={earlier} loadingEarlier={loadingEarlier} onLoadEarlier={loadEarlier} onLoadToolOutput={loadToolOutput} loadingSession={id !== null && snapshot === null} cwd={snapshot?.session.cwd ?? project?.path ?? null} snapshot={snapshot} defaults={defaults} busy={busy || !online || (!id && !defaults)} error={error} insertion={insertion} onInsertionConsumed={() => setInsertion(null)} terminalOpen={false} browserOpen={false}
					onPickProject={() => setProjectSheet(true)} onSend={send} onStartSession={send} onAbort={() => { const target = selected.current; if (target) void action(async () => { const next = await desktop.abort(target); if (selected.current === target) setSnapshot(next); }); }}
					onSetModel={(modelKey) => configure({ modelKey })} onSetThinking={(thinkingLevel) => configure({ thinkingLevel })} onSetMode={(mode) => configure({ mode })} onSetWorkMode={(workMode) => configure({ workMode })} onSetFusion={(fusion) => configure({ fusion })}
					onToggleBrowser={noop} onToggleTerminal={noop} onOpenCheckpoints={noop} onDismissError={() => setError(null)}
					loadCommands={() => selected.current ? desktop.commands(selected.current) : Promise.resolve([])}
					onAnswerWorkflow={async (answer) => { const target = selected.current; if (!target) return; const next = await desktop.answer(target, answer); if (selected.current === target) setSnapshot(next); }}
					onCancelWorker={async (workerId) => { const target = selected.current; if (!target) return; const next = await desktop.cancelWorker(target, workerId); if (selected.current === target) setSnapshot(next); }}
				/>
			</main>}
			{view === "settings" && <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5 text-sm">
				<section><h2 className="mb-2 font-medium">已连接电脑（{transport === "relay" ? "公网连接" : "局域网"}）</h2><p className="text-muted-foreground">{desktop.binding?.name}</p><p className="mt-1 break-all text-xs text-muted-foreground">{desktop.binding?.endpoint}</p>
					{transport !== "relay" && desktop.hasRelay ? <Button variant="subtle" className="mt-3" disabled={busy} onClick={() => { void action(async () => { await desktop.switch("relay"); clearSession(); setTransport("relay"); await refresh(); }); }}>切换到公网连接</Button> : null}
					{transport !== "lan" && desktop.hasLan ? <Button variant="subtle" className="mt-3" disabled={busy} onClick={() => { void action(async () => { await desktop.switch("lan"); clearSession(); setTransport("lan"); await refresh(); }); }}>切换到局域网</Button> : null}
				</section>
				<div className="flex items-center justify-between"><span>外观</span><Button variant="subtle" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>{resolvedTheme === "dark" ? "深色" : "浅色"}</Button></div>
				<section><h2 className="mb-2 font-medium">并行任务</h2><p className="text-xs leading-relaxed text-muted-foreground">手机与桌面共享任务列表。新任务独立运行，切换会话不会停止后台任务。同一项目中的任务共享文件，请避免同时修改相同文件。</p></section>
				<p className="text-xs leading-relaxed text-muted-foreground">电脑需保持唤醒并运行 NekoCode。{transport === "relay" ? "公网连接通过账号服务器中转，消息端到端加密；设备公钥由服务器分发，请只在可信服务上使用。" : "局域网 HTTP 连接仅适用于可信网络。"}</p>
				<section><h2 className="mb-2 font-medium">公网连接</h2><PublicConnectionView busy={busy} activeDesktopId={desktop.activeRelayDeviceId ?? undefined}
					onConnect={async (device) => action(async () => { await desktop.selectRelay(device); clearSession(); setTransport("relay"); await refresh(); })}
					onSignedOut={() => { void (async () => { if (transport === "relay") { if (desktop.hasLan) { await desktop.switch("lan"); clearSession(); setTransport("lan"); await refresh(); } else { await desktop.deactivate(); setTransport(null); setPaired(false); setOnline(false); } } })().catch((cause) => setError(message(cause))); }} /></section>
				<Button variant="subtle" onClick={() => { void action(async () => {
					await desktop.disconnect();
					const fallback = desktop.mode;
					clearSession(); setTransport(fallback); setOnline(false);
					if (fallback) { setPaired(true); await refresh(); } else setPaired(false);
				}); }}>断开并移除当前连接</Button>
			</div>}
		</>}
		{projectSheet && paired && <div className="absolute inset-0 z-50 flex flex-col bg-background px-4 pb-6 pt-[max(1rem,env(safe-area-inset-top))]" role="dialog" aria-modal="true" aria-label="选择项目">
			<div className="mb-6 flex items-center justify-between"><h2 className="text-base font-medium">选择项目</h2><Button aria-label="关闭项目选择" size="icon" variant="ghost" onClick={() => setProjectSheet(false)}><XIcon className="size-4" /></Button></div>
			<p className="mb-4 text-xs text-muted-foreground">在此项目创建新的独立任务</p>
			<div className="min-h-0 flex-1 overflow-y-auto">{projects.length ? projects.map((p) => <button key={p.id} className="mb-2 flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-muted" onClick={() => { newTask(p.id); setProjectSheet(false); }}><FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block text-sm">{p.name}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{p.path}</span></span></button>) : <p className="rounded-lg bg-muted p-4 text-sm leading-relaxed text-muted-foreground">请先在电脑「设置 → 手机连接」中添加允许新建任务的项目。</p>}</div>
		</div>}
	</div>;
}
