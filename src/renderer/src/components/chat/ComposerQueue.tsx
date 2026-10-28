import { useTranslation } from "../../i18n";
import { ComposerSendArrowIcon, SteerIcon, XIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
import { COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME } from "./composerPickerStyles";
import type { QueuedPrompt } from "./useComposerQueue";

/** Queued follow-ups attached to the composer, oldest first. */
export function ComposerQueue({ items, streaming, canSteer, sendingId, error, onSendNow, onRemove }: {
	items: QueuedPrompt[];
	streaming: boolean;
	canSteer: boolean;
	sendingId: number | null;
	error?: string;
	onSendNow: (id: number) => void;
	onRemove: (id: number) => void;
}) {
	const { t } = useTranslation();
	if (items.length === 0) return null;
	return (
		<ComposerStackedHeaderFrame data-composer-queue="" className="relative z-10">
			<section
				aria-label={t("composer.queuedTitle", { count: items.length })}
				title={t("composer.queuedHint")}
				className={`chat-composer-stacked-top max-h-48 overflow-y-auto border bg-popover/95 ${COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME}`}
			>
				{items.length > 1 ? <div className="flex h-7 items-center gap-2 border-b border-border/60 px-3 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					<SteerIcon className="size-3 shrink-0" />
					<span>{t("composer.queuedTitle", { count: items.length })}</span>
					<span className="truncate">{t("composer.queuedHint")}</span>
				</div> : null}
				{items.map((item) => (
					<div key={item.id} data-composer-queued-message={item.id} className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0">
						<SteerIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)]" title={item.request.text}>
							{item.request.text}
						</span>
						{item.request.images?.length ? <span className="shrink-0 text-xs text-muted-foreground">+{item.request.images.length} 📎</span> : null}
						{!streaming || canSteer ? (
							<Button
								disabled={sendingId !== null}
								title={t(streaming ? "composer.steerHint" : "composer.send")}
								size="chip"
								variant="ghost"
								onClick={() => onSendNow(item.id)}
							>
								<ComposerSendArrowIcon className="size-3" />
								{sendingId === item.id ? t("composer.sendingQueued") : t(streaming ? "composer.steer" : "composer.send")}
							</Button>
						) : null}
						<Button
							disabled={sendingId === item.id}
							aria-label={t("composer.removeQueued")}
							title={t("composer.removeQueued")}
							size="icon-chip"
							variant="ghost"
							onClick={() => onRemove(item.id)}
						>
							<XIcon className="size-3" />
						</Button>
					</div>
				))}
				{error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
			</section>
		</ComposerStackedHeaderFrame>
	);
}
