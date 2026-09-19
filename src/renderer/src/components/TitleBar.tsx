import { api } from "../api";
import { useTranslation } from "../i18n";
import { PanelLeftIcon, PanelRightCloseIcon } from "../lib/icons";
import { isMacNavigatorPlatform } from "../lib/utils";
import { IconButton } from "./ui/icon-button";

/**
 * The app-drawn caption strip.
 *
 * The window is frameless (`titleBarStyle: "hidden"`), so this row is the only
 * thing that makes the window draggable — it spans the full width above the
 * sidebar and the content so every view gets a drag handle, including the empty
 * states that have no header of their own.
 *
 * The minimize/maximize/close buttons are *not* drawn here: Windows paints them
 * over the top-right of this row (Window Controls Overlay) so Snap Layouts keeps
 * working. `.app-titlebar` reserves their width, and macOS gets a fixed left
 * inset for the traffic lights instead.
 */
export function TitleBar({
	projectLabel,
	sidebarOpen,
	onToggleSidebar,
	dockOpen,
	onToggleDock,
}: {
	projectLabel: string | null;
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
	dockOpen: boolean;
	onToggleDock: () => void;
}) {
	const { t } = useTranslation();
	return (
		<header
			className="app-titlebar flex shrink-0 select-none items-center gap-1.5"
			data-mac={isMacNavigatorPlatform() ? "" : undefined}
			style={{ height: api.shell.titleBarHeight }}
		>
			<IconButton
				aria-pressed={sidebarOpen}
				label={t("sidebar.toggleSidebar")}
				onClick={onToggleSidebar}
				tooltip={t("sidebar.toggleSidebar")}
				tooltipSide="bottom"
			>
				<PanelLeftIcon className="size-3.5" />
			</IconButton>
			<img src="./icon.png" alt="" aria-hidden="true" draggable={false} className="size-5 shrink-0" />
			<span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground/85">
				NekoCode
			</span>
			{projectLabel ? (
				<>
					<span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/40">
						/
					</span>
					<span className="min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{projectLabel}
					</span>
				</>
			) : null}
			<div className="flex-1" />
			<IconButton
				aria-pressed={dockOpen}
				label={t("dock.toggle")}
				onClick={onToggleDock}
				tooltip={t("dock.toggle")}
				tooltipSide="bottom"
			>
				<PanelRightCloseIcon className="size-3.5" />
			</IconButton>
		</header>
	);
}
