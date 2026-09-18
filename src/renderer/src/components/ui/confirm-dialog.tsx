"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";

/**
 * The app's one modal confirmation.
 *
 * An alert dialog rather than an inline confirm strip — the pattern the session
 * rows use — because the actions behind this one are not scoped to a row and are
 * not cheap to undo: a checkpoint restore rewrites files on disk. A modal is the
 * right amount of friction for an action whose blast radius is the whole
 * working tree, and it is the only place in the app where taking the user's
 * focus is the point rather than a cost.
 *
 * Deliberately not dismissable by clicking away: Base UI's AlertDialog already
 * requires an explicit choice, which is what keeps a stray click on the backdrop
 * from reading as "cancel" when the user meant to scroll the file list.
 */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
	footer,
	/** Widen past the default for dialogs that list files. */
	wide,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: React.ReactNode;
	description?: React.ReactNode;
	/** The body between the description and the buttons. */
	children?: React.ReactNode;
	footer: React.ReactNode;
	wide?: boolean;
}) {
	return (
		<AlertDialog.Root open={open} onOpenChange={onOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<AlertDialog.Popup
					className={cn(
						"fixed left-1/2 top-1/2 z-50 flex max-h-[min(34rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
						"flex-col gap-3 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						wide ? "w-[32rem] max-w-[calc(100vw-3rem)]" : "w-96 max-w-[calc(100vw-3rem)]",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<div className="flex shrink-0 flex-col gap-1">
						<AlertDialog.Title className="text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
							{title}
						</AlertDialog.Title>
						{description ? (
							<AlertDialog.Description className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{description}
							</AlertDialog.Description>
						) : null}
					</div>
					{children ? <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">{children}</div> : null}
					<div className="flex shrink-0 items-center justify-end gap-2">{footer}</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}
