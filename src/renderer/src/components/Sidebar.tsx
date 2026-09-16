import { useMemo } from "react";
import type { ThreadSummary } from "../../../shared/agent";
import type { ThemeMode } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import {
	SIDEBAR_HEADER_ROW_CLASS_NAME,
	SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
	SIDEBAR_ROW_ACTIVE_CLASS_NAME,
	SIDEBAR_ROW_HOVER_CLASS_NAME,
	SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
	SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
	SIDEBAR_SECTION_LABEL_CLASS_NAME,
	SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../lib/sidebarRowStyles";
import type { WorkspaceView } from "../App";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
	FolderOpenIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	GlobeIcon,
	MoonIcon,
	NewThreadIcon,
	SettingsIcon,
	SunIcon,
	WorkflowIcon,
} from "../lib/icons";

/** Full-surface destinations that live below the thread list. */
const SECONDARY_NAV: ReadonlyArray<{
	id: Exclude<WorkspaceView, "chat">;
	label: string;
	icon: typeof GitBranchIcon;
}> = [
	{ id: "review", label: "Review", icon: GitBranchIcon },
	{ id: "pull-requests", label: "Pull requests", icon: GitPullRequestIcon },
	{ id: "automations", label: "Automations", icon: WorkflowIcon },
];

function projectLabel(cwd: string | null): string {
	if (!cwd) return "No project";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}

function threadTime(timestamp: number): string {
	const delta = Date.now() - timestamp;
	const minutes = Math.round(delta / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

interface SidebarProps {
	cwd: string | null;
	threads: ThreadSummary[];
	activeThreadId: string | null;
	view: WorkspaceView;
	busy: boolean;
	theme: ThemeMode;
	resolvedTheme: "light" | "dark";
	browserOpen: boolean;
	onPickProject: () => void;
	onNewThread: () => void;
	onOpenThread: (thread: ThreadSummary) => void;
	onSelectView: (view: WorkspaceView) => void;
	onToggleBrowser: () => void;
	onToggleTheme: () => void;
}

export function Sidebar(props: SidebarProps) {
	const {
		cwd,
		threads,
		activeThreadId,
		view,
		busy,
		theme,
		resolvedTheme,
		browserOpen,
		onPickProject,
		onNewThread,
		onOpenThread,
		onSelectView,
		onToggleBrowser,
		onToggleTheme,
	} = props;

	const sortedThreads = useMemo(
		() => [...threads].sort((a, b) => b.updatedAt - a.updatedAt),
		[threads],
	);

	return (
		<aside
			className={cn(
				"app-sidebar-surface flex h-full w-[260px] min-w-[220px] shrink-0 flex-col",
				"border-r border-[color:var(--sidebar-border)]",
			)}
		>
			<div className="flex flex-col gap-1 px-2 pb-1 pt-2.5">
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={onPickProject}
								className={cn(
									SIDEBAR_HEADER_ROW_CLASS_NAME,
									SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
									SIDEBAR_ROW_HOVER_CLASS_NAME,
								)}
							/>
						}
					>
						<FolderOpenIcon className="size-3.5 shrink-0 opacity-80" />
						<span className="min-w-0 flex-1 truncate">{projectLabel(cwd)}</span>
					</TooltipTrigger>
					<TooltipPopup side="bottom">
						{cwd ?? "Choose a project directory"}
					</TooltipPopup>
				</Tooltip>

				<div className="flex items-center gap-1 px-1">
					<Button
						className="flex-1 justify-start"
						disabled={!cwd || busy}
						onClick={onNewThread}
						size="sm"
						variant="subtle"
					>
						<NewThreadIcon className="size-3.5" />
						New thread
					</Button>
					<IconButton label="Toggle theme" onClick={onToggleTheme} tooltip="Toggle theme">
						{resolvedTheme === "dark" ? (
							<SunIcon className="size-3.5" />
						) : (
							<MoonIcon className="size-3.5" />
						)}
					</IconButton>
					<IconButton
						label="Settings"
						onClick={() => onSelectView("settings")}
						tooltip="Settings"
					>
						<SettingsIcon className="size-3.5" />
					</IconButton>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-1 px-2 pt-2">
				<div className="flex items-center justify-between px-2">
					<span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Threads</span>
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/50">
						{threads.length}
					</span>
				</div>
				<div
					className={cn(
						"flex min-h-0 flex-1 flex-col overflow-y-auto",
						SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
					)}
				>
					{sortedThreads.length === 0 ? (
						<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">
							{cwd ? "No threads yet." : "Choose a project to begin."}
						</p>
					) : (
						sortedThreads.map((thread) => {
							const isActive = thread.id === activeThreadId && view === "chat";
							return (
								<button
									key={thread.id}
									type="button"
									onClick={() => onOpenThread(thread)}
									className={cn(
										SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
										"flex items-center gap-1.5 pr-2",
										isActive
											? SIDEBAR_ROW_ACTIVE_CLASS_NAME
											: cn(SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
									)}
								>
									<span className="min-w-0 flex-1 truncate">{thread.title}</span>
									<span className="shrink-0 text-[length:var(--app-font-size-ui-timestamp,8px)] text-muted-foreground/50">
										{threadTime(thread.updatedAt)}
									</span>
								</button>
							);
						})
					)}
				</div>
			</div>

			<div className="flex flex-col gap-1 px-2 pb-2 pt-1">
				{SECONDARY_NAV.map((entry) => (
					<button
						key={entry.id}
						type="button"
						onClick={() => onSelectView(entry.id)}
						className={cn(
							SIDEBAR_HEADER_ROW_CLASS_NAME,
							view === entry.id
								? SIDEBAR_ROW_ACTIVE_CLASS_NAME
								: cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
						)}
					>
						<entry.icon className="size-3.5 shrink-0 opacity-80" />
						<span className="min-w-0 flex-1 truncate">{entry.label}</span>
					</button>
				))}
				<button
					type="button"
					aria-pressed={browserOpen}
					onClick={onToggleBrowser}
					className={cn(
						SIDEBAR_HEADER_ROW_CLASS_NAME,
						browserOpen
							? SIDEBAR_ROW_ACTIVE_CLASS_NAME
							: cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
					)}
				>
					<GlobeIcon className="size-3.5 shrink-0 opacity-80" />
					<span className="min-w-0 flex-1 truncate">Browser</span>
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/50">
						{browserOpen ? "on" : "off"}
					</span>
				</button>
				<button
					type="button"
					onClick={() => onSelectView("settings")}
					className={cn(
						SIDEBAR_HEADER_ROW_CLASS_NAME,
						view === "settings"
							? SIDEBAR_ROW_ACTIVE_CLASS_NAME
							: cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
					)}
				>
					<SettingsIcon className="size-3.5 shrink-0 opacity-80" />
					<span className="min-w-0 flex-1 truncate">Settings</span>
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/50">
						{theme}
					</span>
				</button>
			</div>
		</aside>
	);
}
