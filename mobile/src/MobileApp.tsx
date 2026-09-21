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
import { lan, LanError } from "./lan-client";

const noop = () => undefined;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function MobileApp() {
	const { resolvedTheme, setTheme } = useTheme();
	useAppearanceVariables({ density: "comfortable", chatWidth: "full", chatFontSizePx: 14, terminalFontSizePx: 13 });
	const [ready, setReady] = useState(false);
	const [paired, setPaired] = useState(false);
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
	const [endpoint, setEndpoint] = useState("");
	const refreshing = useRef(false);
	const navigation = useRef({ view, projectSheet });
	navigation.current = { view, projectSheet };

	const disconnected = useCallback((cause: unknown) => {
		setOnline(false);
		if (cause instanceof LanError && cause.status === 401) {
			void lan.disconnect(); setPaired(false); setError(cause.message);
		}
	}, []);

	const refresh = useCallback(async () => {
		if (!lan.binding || refreshing.current || document.hidden) return;
		refreshing.current = true;
		const binding = lan.binding;
		try {
			const state = await lan.state();
			if (lan.binding !== binding) return;
			setSessions(state.tasks.map((task) => ({ ...task, sessionFile: "" })));
			setProjects(state.projects);
			setProjectId((previous) => state.projects.some((p) => p.id === previous) ? previous : state.projects[0]?.id ?? "");
			const selectedId = selected.current;
			if (selectedId) {
				if (!state.tasks.some((task) => task.id === selectedId)) {
					selected.current = null; setId(null); setSnapshot(null); setView("tasks");
				} else {
					const next = await lan.snapshot(selectedId);
					if (selected.current === selectedId && lan.binding === binding) setSnapshot(next);
				}
			}
			setOnline(true);
		} catch (cause) { if (lan.binding === binding) disconnected(cause); }
		finally { refreshing.current = false; }
	}, [disconnected]);

	useEffect(() => {
		let alive = true;
		void lan.restore().then((binding) => {
			if (!alive) return;
			setPaired(!!binding); setEndpoint(binding?.endpoint ?? ""); setReady(true); void refresh();
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
		void lan.defaults(projectId).then((next) => { if (!cancelled) setDefaults(next); })
			.catch((cause) => { if (!cancelled) setError(message(cause)); });
		return () => { cancelled = true; };
	}, [paired, projectId, id]);

	const action = async (run: () => Promise<void>) => {
		if (busyRef.current) return;
		busyRef.current = true; setBusy(true); setError(null);
		try { await run(); }
		catch (cause) { setError(message(cause)); if (cause instanceof LanError && cause.status === 401) disconnected(cause); }
		finally { busyRef.current = false; setBusy(false); }
	};

	const open = (session: SessionSummary) => action(async () => {
		const next = await lan.snapshot(session.id);
		selected.current = session.id; setId(session.id); setSnapshot(next); setView("chat");
	});

	const newTask = (project?: string) => {
		selected.current = null; setId(null); setSnapshot(null); setInsertion(null); setError(null);
		if (project) setProjectId(project);
		setView("chat"); setProjectSheet(!project && projects.length !== 1);
	};

	const configure = (options: LanTaskOptions) => {
		if (selected.current) {
			const target = selected.current;
			void action(async () => { const next = await lan.configure(target, options); if (selected.current === target) setSnapshot(next); });
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
				const result = await lan.send(target, text);
				if (!result.accepted) throw new Error(result.error);
				if (result.action === "new-session") { newTask(projects.find((p) => p.path === snapshot?.session.cwd)?.id); return; }
			} else {
				if (!defaults || !projectId) throw new Error("请先选择电脑授权的项目");
				const options: LanTaskOptions = {
					modelKey: defaults.fusion ? undefined : defaults.modelKey ?? undefined,
					fusion: defaults.fusion ?? undefined, thinkingLevel: defaults.thinkingLevel,
					mode: defaults.mode, workMode: defaults.workMode,
				};
				const result = await lan.create(projectId, text, options);
				const next = await lan.snapshot(result.id);
				selected.current = result.id; setId(result.id); setSnapshot(next);
				if (!result.accepted) throw new Error(result.error ?? "任务已创建，但未能开始执行");
			}
			await refresh();
		} catch (cause) { setInsertion({ id: crypto.randomUUID(), text }); throw cause; }
	});

	const project = projects.find((p) => p.id === projectId);
	const groups = new Map<string, SessionSummary[]>();
	for (const task of sessions) groups.set(task.cwd, [...(groups.get(task.cwd) ?? []), task]);

	return <div className="mobile-shell flex flex-col bg-background text-foreground">
		{!ready ? <div className="flex flex-1 items-center justify-center"><Spinner /></div> : !paired ?
			<PairingView initialEndpoint={endpoint} busy={busy} error={error} onError={setError} onPair={(address, code, name) => action(async () => {
				await lan.pair(address, code, name); setEndpoint(address); setPaired(true); setView("tasks"); await refresh();
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
				<ChatView key={id ?? `new:${projectId}`} mobile cwd={snapshot?.session.cwd ?? project?.path ?? null} snapshot={snapshot} defaults={defaults} busy={busy || !online || (!id && !defaults)} error={error} insertion={insertion} onInsertionConsumed={() => setInsertion(null)} terminalOpen={false} browserOpen={false}
					onPickProject={() => setProjectSheet(true)} onSend={send} onStartSession={send} onAbort={() => { const target = selected.current; if (target) void action(async () => { const next = await lan.abort(target); if (selected.current === target) setSnapshot(next); }); }}
					onSetModel={(modelKey) => configure({ modelKey })} onSetThinking={(thinkingLevel) => configure({ thinkingLevel })} onSetMode={(mode) => configure({ mode })} onSetWorkMode={(workMode) => configure({ workMode })} onSetFusion={(fusion) => configure({ fusion })}
					onToggleBrowser={noop} onToggleTerminal={noop} onOpenCheckpoints={noop} onDismissError={() => setError(null)}
					loadCommands={() => selected.current ? lan.commands(selected.current) : Promise.resolve([])}
					onAnswerWorkflow={async (answer) => { const target = selected.current; if (!target) return; const next = await lan.answer(target, answer); if (selected.current === target) setSnapshot(next); }}
					onCancelWorker={async (workerId) => { const target = selected.current; if (!target) return; const next = await lan.cancelWorker(target, workerId); if (selected.current === target) setSnapshot(next); }}
				/>
			</main>}
			{view === "settings" && <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5 text-sm">
				<section><h2 className="mb-2 font-medium">已绑定电脑</h2><p className="text-muted-foreground">{lan.binding?.name}</p><p className="mt-1 break-all text-xs text-muted-foreground">{lan.binding?.endpoint}</p></section>
				<div className="flex items-center justify-between"><span>外观</span><Button variant="subtle" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>{resolvedTheme === "dark" ? "深色" : "浅色"}</Button></div>
				<section><h2 className="mb-2 font-medium">并行任务</h2><p className="text-xs leading-relaxed text-muted-foreground">手机与桌面共享任务列表。新任务独立运行，切换会话不会停止后台任务。同一项目中的任务共享文件，请避免同时修改相同文件。</p></section>
				<p className="text-xs leading-relaxed text-muted-foreground">电脑需保持唤醒并运行 NekoCode。局域网 HTTP 连接仅适用于可信网络。</p>
				<Button variant="subtle" onClick={() => { void action(async () => { await lan.disconnect(); setPaired(false); selected.current = null; setId(null); setSnapshot(null); setSessions([]); setDefaults(null); setProjects([]); setOnline(false); }); }}>断开并移除本机绑定</Button>
			</div>}
		</>}
		{projectSheet && paired && <div className="absolute inset-0 z-50 flex flex-col bg-background px-4 pb-6 pt-[max(1rem,env(safe-area-inset-top))]" role="dialog" aria-modal="true" aria-label="选择项目">
			<div className="mb-6 flex items-center justify-between"><h2 className="text-base font-medium">选择项目</h2><Button aria-label="关闭项目选择" size="icon" variant="ghost" onClick={() => setProjectSheet(false)}><XIcon className="size-4" /></Button></div>
			<p className="mb-4 text-xs text-muted-foreground">在此项目创建新的独立任务</p>
			<div className="min-h-0 flex-1 overflow-y-auto">{projects.length ? projects.map((p) => <button key={p.id} className="mb-2 flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-muted" onClick={() => { newTask(p.id); setProjectSheet(false); }}><FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block text-sm">{p.name}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{p.path}</span></span></button>) : <p className="rounded-lg bg-muted p-4 text-sm leading-relaxed text-muted-foreground">请先在电脑「设置 → 手机连接」中添加允许新建任务的项目。</p>}</div>
		</div>}
	</div>;
}
