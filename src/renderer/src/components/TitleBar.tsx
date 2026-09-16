import { api } from "../api";
import { isMacNavigatorPlatform } from "../lib/utils";

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
export function TitleBar({ projectLabel }: { projectLabel: string | null }) {
	return (
		<header
			className="app-titlebar flex shrink-0 select-none items-center gap-1.5"
			data-mac={isMacNavigatorPlatform() ? "" : undefined}
			style={{ height: api.shell.titleBarHeight }}
		>
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
		</header>
	);
}
