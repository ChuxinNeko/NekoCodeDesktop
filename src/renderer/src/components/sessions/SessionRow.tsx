import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../../../shared/agent";
import { relativeSessionTime } from "../../../../shared/sessions";
import { useTranslation } from "../../i18n";
import { EllipsisIcon } from "../../lib/icons";
import {
	SIDEBAR_ROW_ACTIVE_CLASS_NAME,
	SIDEBAR_ROW_FOCUS_CLASS_NAME,
	SIDEBAR_ROW_HOVER_CLASS_NAME,
	SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "../../lib/sidebarRowStyles";
import { cn } from "../../lib/utils";
import { startSessionDrag } from "../../lib/sessionDrag";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";

export interface SessionRowProps {
	hideActions?: boolean;
	hideRename?: boolean;
	compact?: boolean;
	disabled?: boolean;
	/** The row can be carried to the chat area to open beside what is there. */
	draggable?: boolean;
	/** Before the title: the external agent the conversation is with. */
	icon?: React.ReactNode;
	session: SessionSummary;
	active: boolean;
	/** The active session is mid-run: the row shows a live indicator. */
	running: boolean;
	now: number;
	renaming: boolean;
	onOpen: () => void;
	onStartRename: () => void;
	onRename: (title: string) => void;
	onCancelRename: () => void;
	onStartDelete: () => void;
}

/** One sidebar session, with inline renaming and a menu that opens deletion confirmation. */
export function SessionRow(props: SessionRowProps) {
	const { t } = useTranslation();
	const { session, active, running, renaming } = props;
	const inputRef = useRef<HTMLInputElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	// Until the model has named a new session, `title` is only its opening
	// prompt — a placeholder reads better than half a sentence that is about to
	// be replaced, and it is the one string here that has to be localized.
	const title = session.titlePending ? t("sessions.pendingTitle") : session.title;

	useEffect(() => {
		if (!renaming) return;
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		input.select();
	}, [renaming]);

	if (renaming) {
		const commit = () => {
			const next = inputRef.current?.value ?? "";
			if (next.trim() && next.trim() !== title) props.onRename(next);
			else props.onCancelRename();
		};
		return (
			<div className="px-1 py-0.5">
				<input
					ref={inputRef}
					defaultValue={title}
					aria-label={t("sessions.nameAria")}
					className={cn(
						"w-full rounded-md border border-[color:var(--color-border-focus)] bg-background px-2 py-1",
						"text-[length:var(--app-font-size-ui-sm,11px)] text-foreground outline-none",
					)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						}
						if (event.key === "Escape") {
							event.preventDefault();
							// Blur would commit, so drop the handler before giving up focus.
							event.currentTarget.value = title;
							props.onCancelRename();
						}
					}}
				/>
			</div>
		);
	}


	return (
		<div
			className={cn(
				"group/row relative flex items-center rounded-md",
				active ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
			)}
			// Right-click opens the same menu the ⋯ button does, anchored to it.
			onContextMenu={(event) => {
				if (props.hideActions) return;
				event.preventDefault();
				setMenuOpen(true);
			}}
		>
			<button
				type="button"
				data-session-file={session.sessionFile}
				disabled={props.disabled}
				aria-current={active ? "page" : undefined}
				title={session.preview ? `${title}\n${session.preview}` : title}
				onClick={props.onOpen}
				draggable={props.draggable && !props.disabled}
				onDragStart={props.draggable ? (event) => startSessionDrag(event, session, title) : undefined}
				className={cn(
					"flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
					SIDEBAR_ROW_FOCUS_CLASS_NAME,
					!active && SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
				)}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{running ? (
						<span
							aria-label={t("sessions.running")}
							className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-text-accent,currentColor)]"
							role="img"
						/>
					) : null}
					{props.icon}
					<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)]">
						{title}
					</span>
				</span>
				{session.preview && !props.compact ? (
					<span className="min-w-0 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
						{session.preview}
					</span>
				) : null}
			</button>

			{/* Timestamp and the actions button share one slot: the time steps aside
			    on hover instead of the row reflowing under the pointer. */}
			<span className="relative flex w-7 shrink-0 items-center justify-end pr-1">
				<span
					className={cn(
						"text-[length:var(--app-font-size-ui-timestamp,8px)] text-muted-foreground/50 transition-opacity",
						"group-hover/row:opacity-0",
						menuOpen && "opacity-0",
					)}
				>
					{relativeSessionTime(session.updatedAt, props.now)}
				</span>
				{!props.hideActions && <Menu open={menuOpen} onOpenChange={setMenuOpen}>
					<MenuTrigger
						render={
							<Button
								aria-label={t("sessions.actionsFor", { title })}
								className={cn(
									"absolute right-0 opacity-0 transition-opacity",
									"group-hover/row:opacity-100 focus-visible:opacity-100",
									menuOpen && "opacity-100",
								)}
								size="icon-xs"
								variant="ghost"
							/>
						}
					>
						<EllipsisIcon className="size-3.5" />
					</MenuTrigger>
					{/* Opaque fill, not the default translucent shell: this menu opens over
					    a dense list of titles, which read straight through a 70% surface.
					    Fixed, tighter corners than the composer pickers (the theme scales the
					    rounded-* tokens up): two short rows at the picker radii read as
					    pills. Options sit 4px in, so 8px − 4px keeps the corners concentric. */}
					<ComposerPickerMenuPopup align="end" className="min-w-28 rounded-[8px] bg-popover" side="bottom">
						{!props.hideRename ? <><MenuItem className="rounded-[4px]" onClick={props.onStartRename}>
							{t("sessions.rename")}
						</MenuItem>
						<MenuSeparator /></> : null}
						<MenuItem className="rounded-[4px]" onClick={props.onStartDelete} variant="destructive">
							{t("common.delete")}
						</MenuItem>
					</ComposerPickerMenuPopup>
				</Menu>}
			</span>
		</div>
	);
}
