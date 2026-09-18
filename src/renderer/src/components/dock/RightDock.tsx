import type { WorkflowTask } from "../../../../shared/workflow";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import {
	SIDEBAR_HEADER_ROW_CLASS_NAME,
	SIDEBAR_ROW_HOVER_CLASS_NAME,
	SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../../lib/sidebarRowStyles";
import {
	BotIcon,
	FoldersIcon,
	GitBranchIcon,
	GlobeIcon,
	PlusIcon,
	TerminalIcon,
	XIcon,
} from "../../lib/icons";
import { IconButton } from "../ui/icon-button";
import { BrowserPanel } from "../BrowserPanel";
import type { BrowserPreviewRequest } from "../../../../shared/browser";
import { FilesPanel } from "./FilesPanel";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { ReviewPanel } from "../ReviewPanel";
import { TerminalPanel } from "../TerminalPanel";

export type DockTool = "review" | "terminal" | "browser" | "files";

/**
 * A dock tab: one of the built-in tools, or one background worker.
 *
 * Workers are addressed by id rather than by a single "worker" tool because
 * four of them can run at once and they are different things — collapsing them
 * into one tab would make watching two workers a matter of switching a hidden
 * selector inside a tab.
 */
export type DockTabId = DockTool | `task:${string}`;

export function taskTabId(taskId: string): DockTabId {
	return `task:${taskId}`;
}

export function taskIdOfTab(tab: DockTabId): string | null {
	return tab.startsWith("task:") ? tab.slice("task:".length) : null;
}

/** Level-1 menu entries, in the order the Codex dock lists them. */
const DOCK_MENU: ReadonlyArray<{
	id: DockTool;
	labelKey: TranslationKey;
	icon: typeof GitBranchIcon;
	shortcut: string;
}> = [
	{ id: "review", labelKey: "nav.review", icon: GitBranchIcon, shortcut: "Ctrl+Shift+G" },
	{ id: "terminal", labelKey: "chat.terminal", icon: TerminalIcon, shortcut: "Ctrl+`" },
	{ id: "browser", labelKey: "nav.browser", icon: GlobeIcon, shortcut: "Ctrl+T" },
	{ id: "files", labelKey: "dock.files", icon: FoldersIcon, shortcut: "Ctrl+P" },
];

const DOCK_TITLES: Record<DockTool, TranslationKey> = {
	review: "nav.review",
	terminal: "chat.terminal",
	browser: "nav.browser",
	files: "dock.files",
};

const DOCK_ICONS: Record<DockTool, typeof GitBranchIcon> = {
	review: GitBranchIcon,
	terminal: TerminalIcon,
	browser: GlobeIcon,
	files: FoldersIcon,
};

interface RightDockProps {
	browserPreview?: BrowserPreviewRequest | null;
	visible?: boolean;
	cwd: string | null;
	tabs: readonly DockTabId[];
	/** The tab on screen, or null for the tool menu ("new tab"). */
	active: DockTabId | null;
	/** Live workers, for worker tab titles and their panels. */
	tasks: readonly WorkflowTask[];
	onSelect: (tab: DockTabId | null) => void;
	onCloseTab: (tab: DockTabId) => void;
	onCancelTask: (taskId: string) => void;
	onCloseDock: () => void;
}

/**
 * Right-hand tool dock.
 *
 * Tabs rather than a drill-down: the tools here are things you leave running —
 * a terminal, a browser, a worker you are watching — and a dock that could only
 * show one at a time made every glance at a second tool a round trip through a
 * menu, losing your place in the first.
 *
 * Every open tab stays mounted so its state survives being switched away from;
 * hiding uses `invisible` rather than unmounting or `display: none`, because a
 * webview torn out of layout loses its size. Closing a tab does unmount it —
 * that is what closing means.
 */
export function RightDock({
	browserPreview,
	visible = true,
	cwd,
	tabs,
	active,
	tasks,
	onSelect,
	onCloseTab,
	onCancelTask,
	onCloseDock,
}: RightDockProps) {
	const { t } = useTranslation();
	const taskById = new Map(tasks.map((task) => [task.id, task]));

	const tabLabel = (tab: DockTabId): string => {
		const taskId = taskIdOfTab(tab);
		if (taskId === null) return t(DOCK_TITLES[tab as DockTool]);
		return taskById.get(taskId)?.description ?? t("dock.subagent");
	};

	const tabIcon = (tab: DockTabId) => {
		const taskId = taskIdOfTab(tab);
		if (taskId === null) {
			const Icon = DOCK_ICONS[tab as DockTool];
			return <Icon className="size-3.5 shrink-0 opacity-80" />;
		}
		const failed = taskById.get(taskId)?.status === "failed";
		return <BotIcon className={cn("size-3.5 shrink-0", failed ? "text-destructive" : "opacity-80")} />;
	};

	return (
		<div className="relative flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)]">
			<div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-[color:var(--app-surface-divider)] px-1.5">
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
					{tabs.map((tab) => (
						<div
							key={tab}
							className={cn(
								"group flex min-w-0 shrink-0 items-center gap-1 rounded px-1.5 py-1",
								"text-[length:var(--app-font-size-ui,12px)] transition-colors",
								tab === active
									? "bg-[var(--color-background-elevated-secondary)] text-foreground"
									: "text-muted-foreground hover:bg-[var(--color-background-elevated-secondary)]",
							)}
						>
							<button
								type="button"
								aria-current={tab === active}
								onClick={() => onSelect(tab)}
								className="flex min-w-0 items-center gap-1"
								title={tabLabel(tab)}
							>
								{tabIcon(tab)}
								<span className="min-w-0 max-w-28 truncate">{tabLabel(tab)}</span>
							</button>
							<button
								type="button"
								aria-label={t("dock.closeTab")}
								onClick={() => onCloseTab(tab)}
								className={cn(
									"shrink-0 rounded opacity-0 transition-opacity",
									"group-hover:opacity-60 hover:!opacity-100",
									tab === active && "opacity-60",
								)}
							>
								<XIcon className="size-3" />
							</button>
						</div>
					))}
					<IconButton
						label={t("dock.newTab")}
						tooltip={t("dock.newTab")}
						onClick={() => onSelect(null)}
					>
						<PlusIcon className="size-3.5" />
					</IconButton>
				</div>
				<IconButton
					label={t("common.close")}
					onClick={onCloseDock}
					tooltip={t("common.close")}
				>
					<XIcon className="size-3.5" />
				</IconButton>
			</div>

			<div className="relative min-h-0 flex-1">
				<div
					className={cn(
						"dock-pane absolute inset-0 flex flex-col gap-1 overflow-y-auto p-2",
						active === null ? "dock-pane-visible" : "dock-pane-hidden",
					)}
				>
					{DOCK_MENU.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => onSelect(entry.id)}
							className={cn(
								SIDEBAR_HEADER_ROW_CLASS_NAME,
								SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
								SIDEBAR_ROW_HOVER_CLASS_NAME,
							)}
						>
							<entry.icon className="size-3.5 shrink-0 opacity-80" />
							<span className="min-w-0 flex-1 truncate">{t(entry.labelKey)}</span>
							<kbd className="shrink-0 rounded border border-[color:var(--app-surface-divider)] px-1 py-px text-[length:var(--app-font-size-ui-xs,10px)] leading-4 text-muted-foreground/60">
								{entry.shortcut}
							</kbd>
						</button>
					))}
				</div>

				{tabs.map((tab) => {
					const taskId = taskIdOfTab(tab);
					const hidden = tab !== active;
					return (
						<div
							key={tab}
							className={cn(
								"absolute inset-0 flex flex-col",
								hidden && "invisible pointer-events-none",
							)}
						>
							{taskId !== null ? (
								<TaskDetailPanel task={taskById.get(taskId) ?? null} onCancel={onCancelTask} />
							) : tab === "review" ? (
								<ReviewPanel cwd={cwd} onClose={() => onCloseTab(tab)} />
							) : tab === "terminal" ? (
								<TerminalPanel cwd={cwd} docked onClose={() => onCloseTab(tab)} />
							) : tab === "browser" ? (
								<BrowserPanel preview={browserPreview} visible={visible && !hidden} onClose={() => onCloseTab(tab)} />
							) : (
								<FilesPanel cwd={cwd} />
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
