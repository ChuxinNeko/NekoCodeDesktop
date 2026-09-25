import { Dialog } from "@base-ui/react/dialog";
import { cn } from "../../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";

/**
 * The frame every settings form opens in: title, a scrolling body, and the
 * buttons pinned below it. The page behind stays a summary of state; the
 * fields that change it live here.
 */
export function SettingsDialog({
	title,
	description,
	children,
	footer,
	onClose,
	wide,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	children: React.ReactNode;
	footer: React.ReactNode;
	onClose: () => void;
	/** For editors that want the room — a whole instruction file, say. */
	wide?: boolean;
}) {
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					className={cn(
						"fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2",
						wide ? "max-h-[min(44rem,calc(100dvh-4rem))]" : "max-h-[min(36rem,calc(100dvh-4rem))]",
						"flex-col gap-3 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						wide ? "w-[48rem] max-w-[calc(100vw-3rem)]" : "w-[32rem] max-w-[calc(100vw-3rem)]",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<div className="flex shrink-0 flex-col gap-1">
						<Dialog.Title className="text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">{title}</Dialog.Title>
						{description ? (
							<Dialog.Description className="break-all text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
								{description}
							</Dialog.Description>
						) : null}
					</div>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">{children}</div>
					<div className="flex shrink-0 items-center justify-end gap-2">{footer}</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** The plain monospace textarea these editors share. */
export const SETTINGS_TEXTAREA_CLASS_NAME =
	"w-full resize-none rounded-lg border border-[color:var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus:border-[color:var(--color-border-focus)]";
