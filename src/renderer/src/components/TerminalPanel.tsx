import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, errorMessage } from "../api";
import { useTranslation } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { XIcon } from "../lib/icons";

export function TerminalPanel({
	cwd,
	onClose,
	docked = false,
}: {
	cwd: string | null;
	onClose: () => void;
	/** Rendered inside the right dock: fill the pane instead of the bottom-drawer chrome. */
	docked?: boolean;
}) {
	const { t } = useTranslation();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [height, setHeight] = useState(240);

	useEffect(() => {
		if (!cwd) return;
		const host = hostRef.current;
		if (!host) return;

		const terminal = new Terminal({
			fontFamily: "var(--font-mono-family, ui-monospace, monospace)",
			fontSize: 12,
			cursorBlink: true,
			theme: { background: "transparent" },
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		fit.fit();
		terminalRef.current = terminal;
		fitRef.current = fit;

		let disposed = false;
		const offData = api.onTerminalData((output) => {
			if (output.id === sessionIdRef.current) terminal.write(output.data);
		});
		const offExit = api.onTerminalExit((exit) => {
			if (exit.id === sessionIdRef.current) {
				terminal.write(`\r\n${t("terminal.exited", { code: exit.exitCode })}\r\n`);
			}
		});

		api
			.terminalCreate({ cwd, cols: terminal.cols, rows: terminal.rows })
			.then((session) => {
				if (disposed) {
					void api.terminalKill(session.id);
					return;
				}
				sessionIdRef.current = session.id;
			})
			.catch((cause: unknown) => setError(errorMessage(cause)));

		const onDataDisposable = terminal.onData((data) => {
			const id = sessionIdRef.current;
			if (id) void api.terminalInput({ id, data });
		});

		const resizeObserver = new ResizeObserver(() => {
			fit.fit();
			const id = sessionIdRef.current;
			if (id) void api.terminalResize({ id, cols: terminal.cols, rows: terminal.rows });
		});
		resizeObserver.observe(host);

		return () => {
			disposed = true;
			offData();
			offExit();
			onDataDisposable.dispose();
			resizeObserver.disconnect();
			const id = sessionIdRef.current;
			sessionIdRef.current = null;
			if (id) void api.terminalKill(id);
			terminal.dispose();
			terminalRef.current = null;
			fitRef.current = null;
		};
	}, [cwd, t]);

	return (
		<div
			className={cn(
				"flex min-h-0 flex-col bg-[var(--color-token-terminal-background)]",
				docked
					? "flex-1"
					: "thread-terminal-drawer shrink-0 border-t border-[color:var(--app-surface-divider)]",
			)}
			style={docked ? undefined : { height }}
		>
			<div className="flex h-8 shrink-0 items-center gap-2 px-2">
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{t("terminal.title")} {cwd ? `— ${cwd}` : ""}
				</span>
				<div className="flex-1" />
				<Button onClick={onClose} size="icon-chip" variant="ghost">
					<XIcon className="size-3" />
				</Button>
			</div>
			{error ? (
				<p className="px-2 pb-1 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</p>
			) : null}
			<div
				ref={hostRef}
				className={cn("min-h-0 flex-1 px-1 pb-1", "[&_.xterm]:h-full")}
				onMouseDown={(event) => event.stopPropagation()}
			/>
		</div>
	);
}
