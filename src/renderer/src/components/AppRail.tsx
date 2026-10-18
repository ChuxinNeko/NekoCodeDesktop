import type { WorkspaceView } from "../App";
import { useTranslation, type TranslationKey } from "../i18n";
import {
	GitBranchIcon, GitHubIcon, GlobeIcon, KanbanIcon,
	MessageCircleIcon, MoonIcon, SettingsIcon, SunIcon, WorkflowIcon,
} from "../lib/icons";
import { cn } from "../lib/utils";
import { IconButton } from "./ui/icon-button";

const DESTINATIONS: ReadonlyArray<{
	id: Exclude<WorkspaceView, "settings">;
	labelKey: TranslationKey;
	icon: typeof MessageCircleIcon;
}> = [
	{ id: "chat", labelKey: "nav.chat", icon: MessageCircleIcon },
	{ id: "tasks", labelKey: "nav.tasks", icon: KanbanIcon },
	{ id: "review", labelKey: "nav.review", icon: GitBranchIcon },
	{ id: "pull-requests", labelKey: "nav.pullRequests", icon: GitHubIcon },
	{ id: "automations", labelKey: "nav.automations", icon: WorkflowIcon },
];

interface AppRailProps {
	view: WorkspaceView;
	activeTasks: number;
	resolvedTheme: "light" | "dark";
	browserAvailable: boolean;
	browserOpen: boolean;
	onSelectView: (view: WorkspaceView) => void;
	onToggleBrowser: () => void;
	onToggleTheme: () => void;
}

/** Persistent navigation beside the independently collapsible session panel. */
export function AppRail(props: AppRailProps) {
	const { t } = useTranslation();
	const buttonClass = (active = false) => cn(
		"relative size-9 shrink-0 rounded-lg text-muted-foreground",
		active && "bg-[var(--sidebar-accent)] text-foreground",
	);
	return (
		<nav aria-label={t("nav.primary")} className="flex h-full w-[52px] shrink-0 flex-col items-center gap-3 py-2.5">
			<div className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto [scrollbar-width:none]">
				{DESTINATIONS.map((entry) => (
					<IconButton
						key={entry.id}
						label={t(entry.labelKey)}
						tooltip={entry.id === "tasks" && props.activeTasks ? `${t(entry.labelKey)} (${props.activeTasks})` : t(entry.labelKey)}
						tooltipSide="right"
						aria-current={props.view === entry.id ? "page" : undefined}
						className={buttonClass(props.view === entry.id)}
						onClick={() => props.onSelectView(entry.id)}
					>
						<entry.icon className="size-[18px]" />
						{entry.id === "tasks" && props.activeTasks > 0 ? (
							<span className="absolute right-1 top-1 size-1.5 rounded-full bg-foreground" />
						) : null}
					</IconButton>
				))}
				{props.browserAvailable ? (
					<>
						<div aria-hidden="true" className="my-0.5 h-px w-5 shrink-0 bg-[var(--sidebar-border)]" />
						<IconButton label={t("nav.browser")} tooltip={t("nav.browser")} tooltipSide="right" aria-pressed={props.browserOpen} className={buttonClass(props.browserOpen)} onClick={props.onToggleBrowser}>
							<GlobeIcon className="size-[18px]" />
						</IconButton>
					</>
				) : null}
			</div>
			<IconButton label={t("sidebar.toggleTheme")} tooltip={t("sidebar.toggleTheme")} tooltipSide="right" className={buttonClass()} onClick={props.onToggleTheme}>
				{props.resolvedTheme === "dark" ? <SunIcon className="size-[18px]" /> : <MoonIcon className="size-[18px]" />}
			</IconButton>
			<IconButton label={t("sidebar.settings")} tooltip={t("sidebar.settings")} tooltipSide="right" aria-current={props.view === "settings" ? "page" : undefined} className={buttonClass(props.view === "settings")} onClick={() => props.onSelectView("settings")}>
				<SettingsIcon className="size-[18px]" />
			</IconButton>
		</nav>
	);
}
