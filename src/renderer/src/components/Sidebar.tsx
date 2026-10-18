import type { SessionSummary } from "../../../shared/agent";
import type { AcpAgentInfo } from "../../../shared/acp";
import { projectLabel } from "../../../shared/paths";
import { api } from "../api";
import { cn } from "../lib/utils";
import {
	SIDEBAR_HEADER_ROW_CLASS_NAME,
	SIDEBAR_ROW_HOVER_CLASS_NAME,
	SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../lib/sidebarRowStyles";
import type { WorkspaceView } from "../App";
import { useTranslation } from "../i18n";
import { SessionList } from "./sessions/SessionList";
import { AgentIcon } from "./agents/AgentIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { FolderOpenIcon, NewThreadIcon } from "../lib/icons";

interface SidebarProps {
	cwd: string | null;
	workspaces: string[];
	/** Workspace keys the user removed from the list. */
	hiddenWorkspaces: string[];
	onRemoveWorkspace: (cwd: string) => void;
	/** NekoLocal's sessions and every enabled agent's, together. */
	sessions: SessionSummary[];
	sessionsLoading: boolean;
	/** The configured agents, for the icon on an agent's rows. */
	agents: readonly AcpAgentInfo[];
	/** Rows can be dragged into the chat area to open side by side. */
	sessionsDraggable?: boolean;
	activeSessionId: string | null;
	streaming: boolean;
	view: WorkspaceView;
	busy: boolean;
	onPickProject: () => void;
	onNewSession: () => void;
	onNewWorkspaceSession: (cwd: string) => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (session: SessionSummary, title: string) => void;
	onDeleteSession: (session: SessionSummary) => void;
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
		onPickProject,
		onNewSession,
		onOpenSession,
		onRenameSession,
		onDeleteSession,
	} = props;
	const { t } = useTranslation();

	return (
		<aside
			aria-label={t("nav.chat")}
			className={cn(
				"flex h-full w-[260px] min-w-[220px] shrink-0 flex-col pb-2",
				"overflow-hidden rounded-l-xl rounded-r-none border border-[color:var(--app-surface-divider)] bg-transparent",
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
			</div>

			<SessionList
				activeId={view === "chat" ? activeSessionId : null}
				currentCwd={cwd}
				workspaces={props.workspaces}
				hiddenWorkspaces={props.hiddenWorkspaces}
				onRemoveWorkspace={props.onRemoveWorkspace}
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
				draggable={props.sessionsDraggable}
				rowIcon={(session) => {
					if (!session.agentId) return null;
					const agent = props.agents.find((entry) => entry.id === session.agentId);
					return (
						<span className="flex shrink-0 text-muted-foreground/70" title={agent?.name ?? session.agentId}>
							<AgentIcon agent={agent} className="size-3" />
						</span>
					);
				}}
			/>
		</aside>
	);
}
