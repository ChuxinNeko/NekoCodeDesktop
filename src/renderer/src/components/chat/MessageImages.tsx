import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import type { PromptImageAttachment } from "../../../../shared/agent";
import { useTranslation } from "../../i18n";
import { XIcon } from "../../lib/icons";

function MessageImage({ image }: { image: PromptImageAttachment }) {
	const { t } = useTranslation();
	const [actualSize, setActualSize] = useState(false);
	const src = `data:${image.mimeType};base64,${image.data}`;
	return (
		<Dialog.Root onOpenChange={() => setActualSize(false)}>
			<Dialog.Trigger aria-label={t("chat.image.open", { name: image.name })}
				className="inline-flex max-w-[min(280px,100%)] cursor-zoom-in items-center justify-center overflow-hidden rounded-lg bg-transparent p-0 ring-1 ring-inset ring-black/10 transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:ring-white/10">
				<img src={src} alt={image.name} loading="lazy" className="block h-auto max-h-44 w-auto max-w-full object-contain" />
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-50 bg-black/75" />
				<Dialog.Popup className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-2xl outline-none">
					<div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
						<Dialog.Title className="min-w-0 flex-1 truncate text-sm">{image.name}</Dialog.Title>
						<button type="button" onClick={() => setActualSize(value => !value)} className="rounded px-2 py-1 text-sm hover:bg-muted">
							{t(actualSize ? "chat.image.fit" : "chat.image.actualSize")}
						</button>
						<Dialog.Close aria-label={t("chat.image.close")} className="rounded p-2 hover:bg-muted"><XIcon className="size-4" /></Dialog.Close>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-2">
						<img src={src} alt={image.name} className={actualSize ? "mx-auto max-w-none" : "h-full w-full object-contain"} />
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function MessageImages({ images }: { images: PromptImageAttachment[] }) {
	return <div className="flex max-w-[min(568px,100%)] flex-wrap items-end justify-end gap-2" data-message-images>
		{images.map((image, index) => <MessageImage key={index} image={image} />)}
	</div>;
}
