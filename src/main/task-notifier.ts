import { Notification, type BrowserWindow } from "electron";
import type { SessionSummary } from "../shared/agent";
import { projectLabel } from "../shared/paths";

/** A toast headline gets unreadable long before the string does. */
const TITLE_MAX = 80;

/** Collapse a task title to something a toast can actually show. */
function toastTitle(session: SessionSummary): string {
	// A title still being written by the model is the raw opening prompt, which
	// is exactly what the sidebar refuses to show — the placeholder is honest.
	if (session.titlePending) return "后台任务已完成";
	const line = session.title.replace(/\s+/g, " ").trim();
	if (!line) return "后台任务已完成";
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * Tells the user a task finished when they were not watching it.
 *
 * Background tasks made this necessary: before them every run was the one on
 * screen, so finishing announced itself. A task started and left behind has no
 * such signal, and without this the only way to learn it is done is to keep
 * checking the sidebar — the work the feature was meant to remove.
 */
export class TaskNotifier {
	constructor(
		private readonly win: BrowserWindow,
		private enabled: boolean,
		/** Bring the window forward on this task — the notification was clicked. */
		private readonly onReveal: (session: SessionSummary) => void,
	) {}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/**
	 * A task stopped running.
	 *
	 * Silent when the user is already looking at it: they watched it happen, and
	 * announcing something visible on screen is noise. Everything else is
	 * announced, the selected task included when the window is in the background
	 * — being selected says nothing about whether anyone is there to see it.
	 */
	settled(session: SessionSummary, selected: boolean): void {
		if (!this.enabled || this.win.isDestroyed()) return;
		if (selected && this.win.isFocused()) return;
		if (!Notification.isSupported()) return;

		const notification = new Notification({
			title: toastTitle(session),
			body: `任务已完成 · ${projectLabel(session.cwd)}`,
			silent: false,
		});
		notification.on("click", () => {
			if (this.win.isDestroyed()) return;
			if (this.win.isMinimized()) this.win.restore();
			this.win.show();
			this.win.focus();
			this.win.flashFrame(false);
			this.onReveal(session);
		});
		notification.show();
		// Windows has no dock icon to badge; a taskbar flash is what it reads.
		if (!this.win.isFocused()) this.win.flashFrame(true);
	}
}
