import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { avatarCropRect, avatarImageFromBitmap, DEFAULT_AVATAR_CROP, moveAvatarCrop } from "../../lib/teamAvatarImage";
import { Button } from "../ui/button";

/** The same source rectangle drives the draggable preview and the exported avatar. */
export function AvatarCropDialog({ bitmap, onCancel, onConfirm }: {
	bitmap: ImageBitmap;
	onCancel: () => void;
	onConfirm: (image: string) => void;
}) {
	const { t } = useTranslation();
	const [crop, setCrop] = useState(DEFAULT_AVATAR_CROP);
	const [error, setError] = useState(false);
	const drag = useRef<{ x: number; y: number; pointerId: number } | null>(null);
	// Dialog portals can mount after the opening render; paint when the actual
	// canvas attaches as well as whenever the crop changes.
	const paint = useCallback((target: HTMLCanvasElement | null) => {
		const context = target?.getContext("2d");
		if (!target || !context) return;
		const rect = avatarCropRect(bitmap.width, bitmap.height, crop);
		context.clearRect(0, 0, target.width, target.height);
		context.imageSmoothingQuality = "high";
		context.drawImage(bitmap, rect.x, rect.y, rect.side, rect.side, 0, 0, target.width, target.height);
	}, [bitmap, crop]);
	return <Dialog.Root open onOpenChange={open => { if (!open) onCancel(); }}>
		<Dialog.Portal>
			<Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[2px]" />
			<Dialog.Popup data-settings-surface="dialog" className="fixed left-1/2 top-1/2 z-[60] flex max-h-[calc(100dvh-2rem)] w-[360px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl outline-none">
				<Dialog.Title className="text-sm font-semibold">{t("team.avatarCropTitle")}</Dialog.Title>
				<Dialog.Description className="text-xs leading-relaxed text-muted-foreground">{t("team.avatarCropHint")}</Dialog.Description>
				<div role="group" aria-label={t("team.avatarCropArea")} tabIndex={0}
					className="relative mx-auto aspect-square w-full max-w-[280px] shrink-0 touch-none select-none overflow-hidden rounded-xl bg-black/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onPointerDown={event => {
						if (event.button !== 0) return;
						event.currentTarget.focus();
						event.currentTarget.setPointerCapture(event.pointerId);
						drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
					}}
					onPointerMove={event => {
						const previous = drag.current;
						if (!previous || previous.pointerId !== event.pointerId) return;
						const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
						drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
						const size = event.currentTarget.getBoundingClientRect().width;
						if (size) setCrop(value => moveAvatarCrop(bitmap.width, bitmap.height, value, dx, dy, size));
					}}
					onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}
					onPointerCancel={() => { drag.current = null; }}
					onLostPointerCapture={() => { drag.current = null; }}
					onKeyDown={event => {
						const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
						if (!direction) return;
						event.preventDefault();
						const step = event.shiftKey ? 30 : 10;
						const size = event.currentTarget.getBoundingClientRect().width;
						if (size) setCrop(value => moveAvatarCrop(bitmap.width, bitmap.height, value, direction[0] * step, direction[1] * step, size));
					}}>
					<canvas ref={paint} width={560} height={560} className="block size-full cursor-grab active:cursor-grabbing" aria-hidden="true" />
					<div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/90 shadow-[0_0_0_100px_rgba(0,0,0,0.5)]" />
				</div>
				<label className="flex items-center gap-3 text-xs text-muted-foreground"><span>{t("team.avatarCropZoom")}</span><input type="range" min={1} max={4} step={0.01} value={crop.zoom} aria-label={t("team.avatarCropZoom")} className="min-w-0 flex-1 accent-primary" onChange={event => setCrop(value => ({ ...value, zoom: Number(event.target.value) }))} /><output className="w-10 text-right tabular-nums">{crop.zoom.toFixed(1)}×</output></label>
				{error ? <p role="alert" className="text-xs text-destructive">{t("team.avatarError.invalid")}</p> : null}
				<div className="flex items-center justify-end gap-2">
					<Button size="sm" variant="ghost" className="mr-auto" onClick={() => setCrop(DEFAULT_AVATAR_CROP)}>{t("team.avatarCropReset")}</Button>
					<Button size="sm" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
					<Button size="sm" onClick={() => { try { onConfirm(avatarImageFromBitmap(bitmap, crop)); } catch { setError(true); } }}>{t("team.avatarCropConfirm")}</Button>
				</div>
			</Dialog.Popup>
		</Dialog.Portal>
	</Dialog.Root>;
}
