import { useEffect, useRef, useState } from "react";
import type { McpSnapshot } from "../../../../shared/mcp";
import { desktopSources, selectDesktopSource } from "../../../../shared/mcp-desktop";
import { keysymForKey, type DesktopAction, type DesktopState } from "../../../../shared/remote-desktop";
import type { SshHost } from "../../../../shared/ssh";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { McpDesktopViewer } from "./McpDesktopViewer";
import { AgentScreen } from "./AgentScreen";
import { DesktopResolutionSettings } from "./DesktopResolutionSettings";
import { SandboxDeploymentStatus, useSandboxDeployments } from "../settings/SandboxDeploymentStatus";
import { Button as ScreenButton } from "../beautiful-ui/Button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** DOM `buttons` bits (1 left, 2 right, 4 middle) as the RFB mask (1 left, 2 middle, 4 right). */
function rfbButtons(buttons: number): number {
	return (buttons & 1) | ((buttons & 4) >> 1) | ((buttons & 2) << 1);
}

/**
 * A saved server's graphical desktop, live, in the dock.
 *
 * The agent and the user share one connection and take turns: while the agent
 * drives, this is a window onto what it does — with a marker where it last
 * acted — and the user's input goes nowhere; "Take over" hands them the mouse
 * and keyboard and makes the agent's next action fail until they hand it back.
 */
export function DesktopPanel({ visible }: { visible: boolean }) {
	const { t } = useTranslation();
	const deployments = useSandboxDeployments();
	const [servers, setServers] = useState<SshHost[]>([]);
	const [states, setStates] = useState<DesktopState[]>([]);
	const [mcp, setMcp] = useState<McpSnapshot>({ servers: [] });
	const [viewerRevision, setViewerRevision] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [resolutionHost, setResolutionHost] = useState<string | null>(null);
	const [confirmReset, setConfirmReset] = useState<string | null>(null);
	const [sandboxBusy, setSandboxBusy] = useState(false);
	const [mark, setMark] = useState<(DesktopAction & { at: number }) | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const pendingMove = useRef<{ x: number; y: number; buttons: number } | null>(null);
	const lastPointer = useRef({ x: 0, y: 0 });
	const pressedKeys = useRef(new Set<number>());
	const heldButtons = useRef(0);

	useEffect(() => {
		api.sshStatus().then((status) => setServers(status.hosts)).catch((cause: unknown) => setError(errorMessage(cause)));
		api.desktopStates().then(setStates).catch(() => {});
		let live = true;
		let changed = false;
		const offMcp = api.onMcpChanged(snapshot => { changed = true; if (live) setMcp(snapshot); });
		void api.mcpList().then(snapshot => { if (live && !changed) setMcp(snapshot); }).catch(() => {});
		const offDesktop = api.onDesktopState(setStates);
		const offHosts = api.onSshChanged(status => { if (live) setServers(status.hosts); });
		return () => { live = false; offMcp(); offDesktop(); offHosts(); };
	}, []);

	// An explicit source wins; otherwise follow the agent's active SSH desktop.
	const sources = desktopSources(servers, mcp);
	const source = selectDesktopSource(sources, selected, states.find(state => state.phase !== "closed")?.hostId);
	const sourceId = source?.id ?? null;
	useEffect(() => { setConfirmReset(null); }, [sourceId]);
	useEffect(() => {
		if (selected && !sources.some(entry => entry.id === selected)) setSelected(null);
	}, [selected, sources]);
	const hostId = source?.kind === "ssh" ? source.hostId : null;
	const state = states.find((entry) => entry.hostId === hostId) ?? null;
	const server = servers.find((entry) => entry.id === hostId);
	const connected = state?.phase === "connected";
	const userDriving = connected && state.controller === "user";
	const sandbox = server?.desktopMode === "sandbox";
	const manageSandbox = async (action: "stop" | "reset") => {
		if (!hostId || sandboxBusy) return;
		releaseInput();
		setSandboxBusy(true);
		setConfirmReset(null);
		try {
			await (action === "stop" ? api.desktopSandboxStop(hostId) : api.desktopSandboxReset(hostId));
			setError(null);
		} catch (cause) { setError(errorMessage(cause)); }
		finally { setSandboxBusy(false); }
	};

	useEffect(() => {
		if (!hostId || !connected || !visible) return;
		const offFrame = api.onDesktopFrame((frame) => {
			if (frame.hostId !== hostId) return;
			const canvas = canvasRef.current;
			const context = canvas?.getContext("2d");
			if (!canvas || !context) return;
			if (canvas.width !== frame.screenWidth || canvas.height !== frame.screenHeight) {
				canvas.width = frame.screenWidth;
				canvas.height = frame.screenHeight;
			}
			// Structured clone over IPC always yields a plain ArrayBuffer.
			const pixels = new Uint8ClampedArray(frame.data.buffer as ArrayBuffer, frame.data.byteOffset, frame.data.byteLength);
			context.putImageData(new ImageData(pixels, frame.width, frame.height), frame.x, frame.y);
		});
		void api.desktopWatch(hostId, true);
		return () => {
			offFrame();
			void api.desktopWatch(hostId, false);
		};
	}, [hostId, connected, visible]);

	useEffect(
		() =>
			api.onDesktopAction((action) => {
				if (action.hostId === hostId) setMark({ ...action, at: Date.now() });
			}),
		[hostId],
	);
	useEffect(() => {
		if (!mark) return;
		const timer = setTimeout(() => setMark(null), 1600);
		return () => clearTimeout(timer);
	}, [mark]);

	const run = (action: Promise<unknown>) => {
		setError(null);
		action.catch((cause: unknown) => setError(errorMessage(cause)));
	};

	/** A pointer event's position in remote-screen pixels. */
	const position = (event: React.PointerEvent | React.WheelEvent) => {
		const canvas = canvasRef.current!;
		const rect = canvas.getBoundingClientRect();
		const point = {
			x: Math.max(0, Math.min(canvas.width - 1, Math.round(((event.clientX - rect.left) * canvas.width) / rect.width))),
			y: Math.max(0, Math.min(canvas.height - 1, Math.round(((event.clientY - rect.top) * canvas.height) / rect.height))),
		};
		lastPointer.current = point;
		return point;
	};

	const sendPointer = (event: React.PointerEvent) => {
		if (!userDriving || !hostId) return;
		const { x, y } = position(event);
		// Do not let a queued drag motion re-press buttons after pointerup.
		pendingMove.current = null;
		heldButtons.current = rfbButtons(event.buttons);
		api.desktopPointer({ hostId, x, y, buttons: heldButtons.current });
	};

	const onMove = (event: React.PointerEvent) => {
		if (!userDriving || !hostId) return;
		// One motion event per frame is all a remote screen can show.
		const first = pendingMove.current === null;
		pendingMove.current = { ...position(event), buttons: rfbButtons(event.buttons) };
		if (!first) return;
		requestAnimationFrame(() => {
			const move = pendingMove.current;
			pendingMove.current = null;
			if (move) api.desktopPointer({ hostId, ...move });
		});
	};

	const onKey = (event: React.KeyboardEvent, down: boolean) => {
		if (!userDriving || !hostId || event.nativeEvent.isComposing) return;
		const keysym = keysymForKey(event.key);
		if (keysym === null) return;
		// Everything goes to the remote desktop, the app's own shortcuts included:
		// Ctrl+T there means a new tab there.
		event.preventDefault();
		event.stopPropagation();
		api.desktopKey({ hostId, keysym, down });
		if (down) pressedKeys.current.add(keysym);
		else pressedKeys.current.delete(keysym);
	};
	const releaseInput = () => {
		if (!hostId) return;
		for (const keysym of pressedKeys.current) api.desktopKey({ hostId, keysym, down: false });
		pressedKeys.current.clear();
		pendingMove.current = null;
		if (heldButtons.current) api.desktopPointer({ hostId, ...lastPointer.current, buttons: 0 });
		heldButtons.current = 0;
	};

	const markStyle = mark && mark.x !== undefined && mark.y !== undefined && state?.width
		? { left: `${(mark.x / state.width) * 100}%`, top: `${(mark.y / state.height) * 100}%` }
		: null;

	return (
		<div className="flex min-h-0 flex-1 flex-col text-[length:var(--app-font-size-ui,12px)]">
			<div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-2 py-1">
				{sources.length ? (
					<Select value={sourceId ?? ""} onValueChange={(value) => value && setSelected(String(value))}>
						<SelectTrigger aria-label={t("desktop.server")} className="h-6 w-auto min-w-0 max-w-48" size="sm" variant="ghost">
							<SelectValue>{source?.name ?? t("desktop.server")}{source?.kind === "mcp" ? " · MCP" : ""}</SelectValue>
						</SelectTrigger>
						<SelectPopup surface="settings">
							{sources.map((entry) => (
								<SelectItem key={entry.id} value={entry.id}>
									{entry.name} · {entry.kind === "mcp" ? "MCP" : "SSH"}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				) : null}
				<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{source?.kind === "mcp" ? t("desktop.mcpReadOnly") : connected ? `${sandbox ? t("ssh.desktop.sandbox") : state.title || server?.host} · ${state.width}×${state.height}` : sandbox ? t("ssh.desktop.sandbox") : ""}
				</span>
				{source?.kind === "mcp" && api.runtime === "electron" ? (
					<Button onClick={() => setViewerRevision(value => value + 1)} size="xs" variant="ghost">{t("desktop.mcpReload")}</Button>
				) : null}
				{hostId && (!state || state.phase === "closed") ? (
					<Button disabled={sandboxBusy} onClick={() => run(api.desktopConnect(hostId))} size="xs" variant="subtle">
						{t("desktop.connect")}
					</Button>
				) : null}
				{hostId && state && state.phase !== "closed" ? (
					<Button onClick={() => run(api.desktopDisconnect(hostId))} size="xs" variant="ghost">
						{t("desktop.disconnect")}
					</Button>
				) : null}
				{hostId && connected ? <Button size="xs" variant="ghost" aria-expanded={resolutionHost === hostId} onClick={() => setResolutionHost(value => value === hostId ? null : hostId)}>{t("desktop.resolution")}</Button> : null}
				{hostId && sandbox ? <>
					<Button disabled={sandboxBusy || state?.phase === "connecting"} size="xs" variant="ghost" onClick={() => void manageSandbox("stop")}>{t("desktop.sandboxStop")}</Button>
					<Button disabled={sandboxBusy || state?.phase === "connecting"} size="xs" variant="ghost" onClick={() => setConfirmReset(hostId)}>{t("desktop.sandboxReset")}</Button>
				</> : null}
			</div>
			{hostId && sandbox && confirmReset === hostId ? <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
				<span>{t("desktop.sandboxResetHint")}</span>
				<Button disabled={sandboxBusy} size="xs" variant="subtle" onClick={() => void manageSandbox("reset")}>{t("desktop.sandboxResetConfirm")}</Button>
				<Button size="xs" variant="ghost" onClick={() => setConfirmReset(null)}>{t("common.cancel")}</Button>
			</div> : null}
			{hostId && connected && resolutionHost === hostId ? <DesktopResolutionSettings key={hostId} hostId={hostId} onBeforeApply={releaseInput} onClose={() => setResolutionHost(null)} /> : null}

			<AgentScreen
				title={source?.name ?? t("dock.desktop")}
				sourceKey={sourceId}
				visible={visible}
				aspectRatio={state?.width && state?.height ? state.width / state.height : undefined}
				expandable={connected || (source?.kind === "mcp" && api.runtime === "electron")}
				onCollapse={releaseInput}
				actions={source?.kind === "mcp" ? <ScreenButton onClick={() => setViewerRevision(value => value + 1)} size="sm" variant="secondary">{t("desktop.mcpReload")}</ScreenButton> : connected ? <ScreenButton onClick={() => hostId && run(api.desktopSetController(hostId, userDriving ? "agent" : "user"))} size="sm" variant="secondary">{t(userDriving ? "desktop.handBack" : "desktop.takeOver")}</ScreenButton> : null}
				footer={connected ? (
					<div className={cn("flex shrink-0 items-center gap-2 border-t border-[color:var(--app-surface-divider)] px-2 py-1.5", userDriving ? "bg-[var(--success,#16a34a)]/10" : "bg-[var(--info)]/10")}>
						<span className={cn("size-2 shrink-0 rounded-full", userDriving ? "bg-[var(--success,#16a34a)]" : "animate-pulse bg-[var(--info)]")} />
						<span className="min-w-0 flex-1 truncate text-xs">{t(userDriving ? "desktop.userDriving" : "desktop.agentDriving")}</span>
						<Button onClick={() => hostId && run(api.desktopSetController(hostId, userDriving ? "agent" : "user"))} size="xs" variant={userDriving ? "chrome-outline" : "subtle"}>
							{t(userDriving ? "desktop.handBack" : "desktop.takeOver")}
						</Button>
					</div>
				) : null}
			>
			{({ expanded, collapse }) => !sources.length ? (
				<p className="m-auto max-w-72 px-4 text-center text-xs leading-relaxed text-muted-foreground">{t("desktop.noServers")}</p>
			) : source?.kind === "mcp" ? (
				<McpDesktopViewer key={`${source.serverId}:${source.viewer.url}`} serverId={source.serverId} viewer={source.viewer} visible={visible} revision={viewerRevision} onRetry={() => setViewerRevision(value => value + 1)} onEscape={expanded ? collapse : undefined} />
			) : state?.phase === "connecting" ? (
				<div className="m-auto flex flex-col gap-2 p-3"><p className="text-xs text-muted-foreground">{t("desktop.connecting")}</p>{sandbox && hostId ? <SandboxDeploymentStatus state={deployments[hostId]} /> : null}</div>
			) : !connected ? (
				<div className="m-auto flex max-w-80 flex-col items-center gap-2 px-4 text-center">
					{state?.error || error ? (
						<p className="whitespace-pre-wrap break-words text-xs text-destructive">{state?.error ?? error}</p>
					) : (
						<p className="text-xs leading-relaxed text-muted-foreground">{t("desktop.idle")}</p>
					)}
				</div>
			) : (
				<>
					<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
						<div className="relative flex max-h-full max-w-full">
							<canvas
								ref={canvasRef}
								tabIndex={expanded ? 0 : -1}
								aria-label={t("desktop.screenTitle", { name: source?.name ?? t("dock.desktop") })}
								className={cn("block max-h-full max-w-full outline-none", userDriving ? "cursor-default" : "cursor-not-allowed")}
								onContextMenu={(event) => event.preventDefault()}
								onPointerDown={(event) => {
									event.currentTarget.focus();
									event.currentTarget.setPointerCapture(event.pointerId);
									sendPointer(event);
								}}
								onPointerUp={sendPointer}
								onPointerCancel={releaseInput}
								onBlur={releaseInput}
								onPointerMove={onMove}
								onWheel={(event) => {
									if (!userDriving || !hostId) return;
									const { x, y } = position(event);
									const button = event.deltaY < 0 ? 8 : event.deltaY > 0 ? 16 : event.deltaX < 0 ? 32 : 64;
									api.desktopPointer({ hostId, x, y, buttons: button });
									api.desktopPointer({ hostId, x, y, buttons: 0 });
								}}
								onKeyDown={(event) => onKey(event, true)}
								onKeyUp={(event) => onKey(event, false)}
							/>
							{markStyle && mark ? (
								<div className="pointer-events-none absolute" style={markStyle}>
									<span className="absolute -left-3 -top-3 size-6 animate-ping rounded-full bg-[var(--info)]/50" />
									<span className="absolute -left-1.5 -top-1.5 size-3 rounded-full border-2 border-white bg-[var(--info)] shadow" />
									<span className="absolute left-3 top-2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white">
										{mark.label}
									</span>
								</div>
							) : null}
						</div>
					</div>
				</>
			)}
			</AgentScreen>
		</div>
	);
}
