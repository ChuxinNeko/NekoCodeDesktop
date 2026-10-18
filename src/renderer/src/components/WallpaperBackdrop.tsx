import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useWallpaperPreferences } from "../hooks/useWallpaperPreferences";
import { wallpaperUploadUrl } from "../../../shared/wallpaper";
import type { WallpaperOrigin, WallpaperPlay } from "../../../shared/wallpaper";

const POINTER_SOURCE = "nekocode-wallpaper";

/**
 * The window's wallpaper, behind the chrome.
 *
 * Custom images and Wallpaper Engine previews are a single picture. Video
 * projects play directly. Scene and web projects go through the live renderer
 * on the wallpaper protocol; the cursor is forwarded because this layer does
 * not take pointer events.
 */
export function WallpaperBackdrop() {
	const { preferences } = useWallpaperPreferences();
	const [origin, setOrigin] = useState<WallpaperOrigin | null>(null);
	const [play, setPlay] = useState<WallpaperPlay | null>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const active = preferences.source !== "none" && preferences.strength > 0 && api.runtime === "electron";
	const imageUrl =
		active && preferences.source === "image" && preferences.imageId && origin
			? wallpaperUploadUrl(origin.base, preferences.imageId)
			: null;
	const engineActive = active && preferences.source === "engine" && Boolean(preferences.engineId);

	useEffect(() => {
		if (!active) return;
		let cancel = false;
		void api.wallpaperOrigin().then((next) => {
			if (!cancel) setOrigin(next);
		}).catch(() => {
			if (!cancel) setOrigin(null);
		});
		return () => {
			cancel = true;
		};
	}, [active]);

	useEffect(() => {
		if (!engineActive || !preferences.engineId) {
			setPlay(null);
			return;
		}
		let cancel = false;
		void api
			.wallpaperPlay({ id: preferences.engineId, fit: preferences.fit, muted: preferences.muted })
			.then((next) => {
				if (!cancel) setPlay(next);
			})
			.catch(() => {
				if (!cancel) setPlay(null);
			});
		return () => {
			cancel = true;
		};
	}, [engineActive, preferences.engineId, preferences.fit, preferences.muted]);

	const showing = Boolean(imageUrl || play);
	useEffect(() => {
		const root = document.documentElement;
		if (!showing) return;
		root.setAttribute("data-wallpaper", "");
		return () => {
			root.removeAttribute("data-wallpaper");
		};
	}, [showing]);

	useEffect(() => {
		if (play?.kind !== "live") return;
		const origin = new URL(play.url).origin;
		const frame = () => frameRef.current?.contentWindow ?? null;
		const send = (payload: Record<string, unknown>) => {
			frame()?.postMessage({ source: POINTER_SOURCE, ...payload }, origin);
		};
		let pending: PointerEvent | null = null;
		let frameId = 0;
		const flush = () => {
			frameId = 0;
			const event = pending;
			pending = null;
			if (!event) return;
			send({
				type: "pointer",
				u: event.clientX / Math.max(1, window.innerWidth),
				v: event.clientY / Math.max(1, window.innerHeight),
				buttons: event.buttons,
				mods: 0,
			});
		};
		const onMove = (event: PointerEvent) => {
			pending = event;
			if (!frameId) frameId = window.requestAnimationFrame(flush);
		};
		const onLeave = () => send({ type: "leave" });
		const onVisibility = () => send({ type: document.hidden ? "pause" : "resume" });
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("blur", onLeave);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			if (frameId) window.cancelAnimationFrame(frameId);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("blur", onLeave);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [play]);

	if (!showing) return null;
	const fit = preferences.fit === "stretch" ? "fill" : preferences.fit;
	const mediaStyle = {
		opacity: preferences.strength / 100,
		filter: preferences.blur > 0 ? `blur(${preferences.blur}px)` : undefined,
		transform: preferences.blur > 0 ? "scale(1.08)" : undefined,
		objectFit: fit,
	} as const;
	const poster = play?.poster ?? null;
	return (
		<div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
			{play?.schemeColor ? <div className="absolute inset-0" style={{ background: play.schemeColor }} /> : null}
			{imageUrl ? <img alt="" className="absolute inset-0 h-full w-full" src={imageUrl} style={mediaStyle} /> : null}
			{poster && play?.kind !== "image" ? <img alt="" className="absolute inset-0 h-full w-full" src={poster} style={mediaStyle} /> : null}
			{play?.kind === "image" ? <img alt="" className="absolute inset-0 h-full w-full" src={play.url} style={mediaStyle} /> : null}
			{play?.kind === "video" ? (
				<video
					autoPlay
					className="absolute inset-0 h-full w-full"
					loop
					muted={preferences.muted}
					playsInline
					src={play.url}
					style={mediaStyle}
				/>
			) : null}
			{play?.kind === "live" ? (
				<div className="absolute inset-0" style={mediaStyle}>
					<iframe className="h-full w-full border-0" ref={frameRef} src={play.url} style={{ background: "transparent" }} title="" />
				</div>
			) : null}
			<div className="absolute inset-0" style={{ background: `rgb(0 0 0 / ${preferences.dim / 100})` }} />
		</div>
	);
}
