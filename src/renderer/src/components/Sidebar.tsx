import type { SessionSummary } from "../../../shared/agent";
import type { ThemeMode } from "../hooks/useTheme";
import { projectLabel } from "../../../shared/paths";
import { api } from "../api";
import { cn } from "../lib/utils";
import {
	SIDEBAR_HEADER_ROW_CLASS_NAME,
	SIDEBAR_ROW_ACTIVE_CLASS_NAME,
	SIDEBAR_ROW_HOVER_CLASS_NAME,
	SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../lib/sidebarRowStyles";
import type { WorkspaceView } from "../App";
import { useTranslation, type TranslationKey } from "../i18n";
import { SessionList } from "./sessions/SessionList";
import { IconButton } from "./ui/icon-button";
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
	labelKey: TranslationKey;
	icon: typeof GitBranchIcon;
}> = [
	{ id: "review", labelKey: "nav.review", icon: GitBranchIcon },
	{ id: "pull-requests", labelKey: "nav.pullRequests", icon: GitPullRequestIcon },
	{ id: "automations", labelKey: "nav.automations", icon: WorkflowIcon },
];

interface SidebarProps {
	cwd: string | null;
	workspaces: string[];
	sessions: SessionSummary[];
	sessionsLoading: boolean;
	activeSessionId: string | null;
	streaming: boolean;
	view: WorkspaceView;
	busy: boolean;
	theme: ThemeMode;
	resolvedTheme: "light" | "dark";
	browserOpen: boolean;
	onPickProject: () => void;
	onNewSession: () => void;
	onNewWorkspaceSession: (cwd: string) => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (session: SessionSummary, title: string) => void;
	onDeleteSession: (session: SessionSummary) => void;
	onSelectView: (view: WorkspaceView) => void;
	onToggleBrowser: () => void;
	onToggleTheme: () => void;
}

export function Sidebar(props: SidebarProps) {
	const {
		cwd,
		sessions,
		sessionsLoading,
		activeSessionId,
		streaming,
		view,
		busy,
		theme,
		resolvedTheme,
		browserOpen,
		onPickProject,
		onNewSession,
		onOpenSession,
		onRenameSession,
		onDeleteSession,
		onSelectView,
		onToggleBrowser,
		onToggleTheme,
	} = props;
	const { t } = useTranslation();

	return (
		<aside
			className={cn(
				"flex h-full w-[260px] min-w-[220px] shrink-0 flex-col",
				"border-r border-[color:var(--sidebar-border)]",
			)}
		>
			<div className="flex flex-col gap-1 px-2 pb-1 pt-2.5">
				<div className="flex items-center gap-1">
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									onClick={onPickProject}
									disabled={busy}
									className={cn(
										SIDEBAR_HEADER_ROW_CLASS_NAME,
										"flex-1",
										SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
										SIDEBAR_ROW_HOVER_CLASS_NAME,
									)}
								/>
							}
						>
							<FolderOpenIcon className="size-3.5 shrink-0 opacity-80" />
							<span className="min-w-0 flex-1 truncate">
								{projectLabel(cwd, api.homeDir)}
							</span>
						</TooltipTrigger>
						<TooltipPopup side="bottom">
							{cwd ?? t("sidebar.projectPicker")}
						</TooltipPopup>
					</Tooltip>
					<IconButton
						label={t("sidebar.toggleTheme")}
						onClick={onToggleTheme}
						tooltip={t("sidebar.toggleTheme")}
					>
						{resolvedTheme === "dark" ? (
							<SunIcon className="size-3.5" />
						) : (
							<MoonIcon className="size-3.5" />
						)}
					</IconButton>
				</div>

				<button
					type="button"
					disabled={!cwd || busy}
					onClick={onNewSession}
					className={cn(
						SIDEBAR_HEADER_ROW_CLASS_NAME,
						SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
						SIDEBAR_ROW_HOVER_CLASS_NAME,
						"disabled:pointer-events-none disabled:opacity-50",
					)}
				>
					<NewThreadIcon className="size-3.5 shrink-0 opacity-80" />
					<span className="min-w-0 flex-1 truncate">{t("sidebar.newSession")}</span>
				</button>

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
						<span className="min-w-0 flex-1 truncate">{t(entry.labelKey)}</span>
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
					<span className="min-w-0 flex-1 truncate">{t("nav.browser")}</span>
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/50">
						{browserOpen ? t("nav.browserOn") : t("nav.browserOff")}
					</span>
				</button>
			</div>

			<SessionList
				activeId={view === "chat" ? activeSessionId : null}
				currentCwd={cwd}
				workspaces={props.workspaces}
				homeDir={api.homeDir}
				busy={busy}
				onAddWorkspace={onPickProject}
				onNewSession={props.onNewWorkspaceSession}
				loading={sessionsLoading}
				onDelete={onDeleteSession}
				onOpen={onOpenSession}
				onRename={onRenameSession}
				sessions={sessions}
				streaming={streaming}
			/>

			<div className="flex flex-col gap-1 px-2 pb-2 pt-1">
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
					<span className="min-w-0 flex-1 truncate">{t("sidebar.settings")}</span>
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/50">
						{t(theme === "dark" ? "theme.dark" : theme === "light" ? "theme.light" : "theme.system")}
					</span>
				</button>
			</div>
		</aside>
	);
}
