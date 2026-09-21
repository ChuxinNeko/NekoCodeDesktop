import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../../../shared/agent";
import { groupSessionsByWorkspace, workspaceKey } from "../../../../shared/sessions";
import { useNow } from "../../hooks/useNow";
import { useTranslation } from "../../i18n";
import { ChevronRightIcon, FolderIcon, PlusIcon, SearchIcon, XIcon } from "../../lib/icons";
import { SIDEBAR_HEADER_ROW_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, SIDEBAR_SECTION_LABEL_CLASS_NAME } from "../../lib/sidebarRowStyles";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SessionRow } from "./SessionRow";

/** Relative timestamps only ever change by the minute, so that is how often they re-render. */
const CLOCK_INTERVAL_MS = 60_000;

const COLLAPSED_KEY = "nekocode:collapsed-workspaces";
function readCollapsed(): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
	} catch { return []; }
}

export interface SessionListProps {
	sessions: SessionSummary[];
	activeId: string | null;
	/** The active session is mid-run. */
	streaming: boolean;
	loading: boolean;
	currentCwd: string | null;
	workspaces: string[];
	homeDir?: string;
	busy: boolean;
	onAddWorkspace: () => void;
	onNewSession: (cwd: string) => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (session: SessionSummary, title: string) => void;
	onDelete: (session: SessionSummary) => void;
}

/**
 * Workspace folders with nested threads, remembered folding, and global search.
 *
 * Grouping and filtering live in `shared/sessions` so workspace boundaries are
 * tested directly; this component only decides what to draw.
 */
export function SessionList(props: SessionListProps) {
	const { t } = useTranslation();
	const { sessions, activeId, currentCwd, loading } = props;
	const now = useNow(CLOCK_INTERVAL_MS);
	const [query, setQuery] = useState("");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [expanded, setExpanded] = useState<string[]>([]);
	const setFolded = (next: string[]) => {
		setCollapsed(next);
		try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* Session-only when storage is unavailable. */ }
	};
	const activeWorkspace = sessions.find((session) => session.id === activeId)?.cwd ?? currentCwd;
	useEffect(() => {
		if (!activeWorkspace) return;
		const key = workspaceKey(activeWorkspace);
		setCollapsed((previous) => {
			const next = previous.filter((entry) => entry !== key);
			try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* Best effort. */ }
			return next;
		});
	}, [activeWorkspace, activeId]);

	const groups = useMemo(
		() => groupSessionsByWorkspace(sessions, { currentCwd, workspaces: props.workspaces, homeDir: props.homeDir, query }),
		[sessions, currentCwd, props.workspaces, props.homeDir, query],
	);

	/**
	 * Arrow keys walk the rows and F2 renames the focused one —
	 * handled at the list so a row never has to know about its neighbours.
	 */
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "F2") return;
		const container = listRef.current;
		if (!container) return;
		const rows = [...container.querySelectorAll<HTMLElement>("[data-session-file]")];
		const index = rows.indexOf(document.activeElement as HTMLElement);
		if (index === -1) return;

		if (event.key === "F2") {
			event.preventDefault();
			const file = rows[index]?.dataset.sessionFile;
			if (file) setRenaming(file);
			return;
		}
		event.preventDefault();
		const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
		next?.focus();
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1 px-2 pt-2">
			<div className="flex items-center justify-between px-2">
				<span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{t("sessions.workspaces")}</span>
				<Button size="icon-xs" variant="ghost" disabled={props.busy} onClick={props.onAddWorkspace} aria-label={t("sessions.addWorkspace")} title={t("sessions.addWorkspace")}><PlusIcon className="size-3.5" /></Button>
			</div>

			{sessions.length > 0 || query ? (
				<div className="relative flex items-center px-1">
					<SearchIcon className="pointer-events-none absolute left-2.5 size-3 text-muted-foreground/50" />
					<input
						aria-label={t("sessions.searchAria")}
						className={cn(
							"w-full rounded-md border border-transparent bg-[var(--color-background-control-opaque,transparent)]",
							"py-1 pl-7 pr-6 text-[length:var(--app-font-size-ui-sm,11px)] text-foreground outline-none",
							"placeholder:text-muted-foreground/50 focus:border-[color:var(--color-border-focus)]",
						)}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setQuery("");
						}}
						placeholder={t("sessions.search")}
						type="text"
						value={query}
					/>
					{query ? (
						<Button
							aria-label={t("sessions.clearSearch")}
							className="absolute right-1.5"
							onClick={() => setQuery("")}
							size="icon-xs"
							variant="ghost"
						>
							<XIcon className="size-3" />
						</Button>
					) : null}
				</div>
			) : null}

			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handling is the point here. */}
			<div
				className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-1"
				onKeyDown={onKeyDown}
				ref={listRef}
			>
				{loading && groups.length === 0 ? (
					<EmptyNote>{t("sessions.loading")}</EmptyNote>
				) : groups.length === 0 && query ? (
					<EmptyNote>{t("sessions.noMatch", { query: query.trim() })}</EmptyNote>
				) : groups.length === 0 ? (
					<EmptyNote>{t("sessions.chooseProject")}</EmptyNote>
				) : (
					groups.map((group) => {
						const folded = !query && collapsed.includes(group.id);
						const showAll = !!query || expanded.includes(group.id);
						const activeIndex = group.sessions.findIndex((session) => session.id === activeId);
						const shown = showAll ? group.sessions : group.sessions.slice(0, Math.max(5, activeIndex + 1));
						const name = group.label || t("sessions.unassigned");
						return <section className="flex flex-col gap-0.5 pb-2" key={group.id} data-workspace={group.cwd}>
							<div className={cn("group/project-header flex items-center rounded-md", SIDEBAR_ROW_HOVER_CLASS_NAME)}>
								<button type="button" aria-expanded={!folded} aria-label={t(folded ? "sessions.expandWorkspace" : "sessions.collapseWorkspace", { name })} title={group.cwd || name}
									onClick={() => setFolded(folded ? collapsed.filter((key) => key !== group.id) : [...collapsed, group.id])}
									className={cn(SIDEBAR_HEADER_ROW_CLASS_NAME, "flex-1 gap-1.5", group.id === (currentCwd ? workspaceKey(currentCwd) : null) ? "text-foreground" : "text-muted-foreground")}>
									<ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", !folded && "rotate-90")} />
									<FolderIcon className="size-3.5 shrink-0" />
									<span className="min-w-0 flex-1 truncate">{name}</span>
								</button>
								{group.cwd ? <Button size="icon-xs" variant="ghost" disabled={props.busy} onClick={() => props.onNewSession(group.cwd)}
									aria-label={t("sessions.newInWorkspace", { name })} title={t("sessions.newInWorkspace", { name })}
									className="mr-1 opacity-0 group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100 focus-visible:opacity-100">
									<PlusIcon className="size-3.5" />
								</Button> : null}
							</div>
							{!folded ? <div className="ml-5 flex flex-col gap-0.5 border-l border-[color:var(--sidebar-border)] pl-1">
							{shown.length === 0 ? <EmptyNote>{t(loading ? "sessions.loading" : "sessions.workspaceEmpty")}</EmptyNote> : null}
							{shown.map((session) => (
								<SessionRow
									compact
									disabled={props.busy}
									active={session.id === activeId}
									confirmingDelete={confirmingDelete === session.sessionFile}
									key={session.sessionFile}
									now={now}
									onCancelDelete={() => setConfirmingDelete(null)}
									onCancelRename={() => setRenaming(null)}
									onDelete={() => {
										setConfirmingDelete(null);
										props.onDelete(session);
									}}
									onOpen={() => props.onOpen(session)}
									onRename={(title) => {
										setRenaming(null);
										props.onRename(session, title);
									}}
									onStartDelete={() => {
										setRenaming(null);
										setConfirmingDelete(session.sessionFile);
									}}
									onStartRename={() => {
										setConfirmingDelete(null);
										setRenaming(session.sessionFile);
									}}
									renaming={renaming === session.sessionFile}
									running={!!session.running || (props.streaming && session.id === activeId)}
									session={session}
								/>
							))}
							{!showAll && shown.length < group.sessions.length ? <button type="button" className="rounded-md px-2 py-1.5 text-left text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground hover:text-foreground" onClick={() => setExpanded([...expanded, group.id])}>{t("sessions.showMore", { count: group.sessions.length - shown.length })}</button> : null}
							</div> : null}
						</section>;
					})
				)}
			</div>
		</div>
	);
}

function EmptyNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">
			{children}
		</p>
	);
}
