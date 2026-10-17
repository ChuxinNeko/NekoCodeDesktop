import { useEffect, useRef, useState } from "react";
import { validateDesktopResolution, type DesktopResolutionInfo } from "../../../../shared/remote-desktop";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const PRESETS = [[1024, 768], [1280, 720], [1280, 800], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]];

export function DesktopResolutionSettings({ hostId, onBeforeApply, onClose }: { hostId: string; onBeforeApply: () => void; onClose: () => void }) {
	const { t } = useTranslation();
	const [info, setInfo] = useState<DesktopResolutionInfo | null>(null);
	const [width, setWidth] = useState("");
	const [height, setHeight] = useState("");
	const [pending, setPending] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		void api.desktopResolutionInfo(hostId).then(value => {
			if (!alive.current) return;
			setInfo(value); setWidth(String(value.width)); setHeight(String(value.height));
		}).catch(cause => { if (alive.current) setError(errorMessage(cause)); })
			.finally(() => { if (alive.current) setPending(false); });
		return () => { alive.current = false; };
	}, [hostId]);
	const blocked = !!info?.blockedReason;
	const presets = [...new Map([...PRESETS.map(([width, height]) => ({ width, height })), ...(info?.modes ?? [])]
		.filter(mode => mode.width >= 256 && mode.height >= 256 && mode.width <= 4096 && mode.height <= 4096)
		.map(mode => [`${mode.width}×${mode.height}`, mode])).entries()];
	const selected = `${Number(width)}×${Number(height)}`;
	const apply = async () => {
		try { validateDesktopResolution(Number(width), Number(height)); }
		catch { setError(t("desktop.resolutionRange")); return; }
		onBeforeApply(); setPending(true); setError(null);
		try {
			const value = await api.desktopSetResolution(hostId, Number(width), Number(height));
			if (alive.current) setInfo(value);
		} catch (cause) { if (alive.current) setError(errorMessage(cause)); }
		finally { if (alive.current) setPending(false); }
	};
	return <section aria-label={t("desktop.resolution")} className="shrink-0 space-y-2 border-b border-[color:var(--app-surface-divider)] p-3 text-xs">
		<div className="flex items-center justify-between gap-2">
			<span className="font-medium">{t("desktop.resolution")}{info ? ` · ${info.width}×${info.height}` : ""}</span>
			<Button size="xs" variant="ghost" onClick={onClose}>{t("desktop.resolutionClose")}</Button>
		</div>
		{pending && !info ? <p role="status">{t("desktop.resolutionLoading")}</p> : null}
		{info ? <>
			<Select value={presets.some(([key]) => key === selected) ? selected : "custom"} onValueChange={key => {
				const mode = presets.find(([id]) => id === key)?.[1];
				if (mode) { setWidth(String(mode.width)); setHeight(String(mode.height)); }
				else { setWidth(""); setHeight(""); }
			}} disabled={pending || blocked}>
				<SelectTrigger size="sm" aria-label={t("desktop.resolutionPreset")}><SelectValue>{presets.some(([key]) => key === selected) ? selected : t("desktop.resolutionCustom")}</SelectValue></SelectTrigger>
				<SelectPopup surface="settings">{presets.map(([key]) => <SelectItem key={key} value={key}>{key}</SelectItem>)}<SelectItem value="custom">{t("desktop.resolutionCustom")}</SelectItem></SelectPopup>
			</Select>
			<div className="flex items-end gap-2">
				<label className="min-w-0 flex-1 space-y-1"><span>{t("desktop.resolutionWidth")}</span><Input type="number" min={256} max={4096} step={1} value={width} onChange={e => setWidth(e.target.value)} disabled={pending || blocked} size="sm" /></label>
				<span className="pb-1.5">×</span>
				<label className="min-w-0 flex-1 space-y-1"><span>{t("desktop.resolutionHeight")}</span><Input type="number" min={256} max={4096} step={1} value={height} onChange={e => setHeight(e.target.value)} disabled={pending || blocked} size="sm" /></label>
				<Button size="xs" variant="subtle" disabled={pending || blocked || !width || !height || (Number(width) === info.width && Number(height) === info.height)} onClick={() => void apply()}>{t(pending ? "desktop.resolutionApplying" : "desktop.resolutionApply")}</Button>
			</div>
			<p className="text-muted-foreground">{t(info.blockedReason === "rdp" ? "desktop.resolutionRdp" : info.blockedReason === "multiple-monitors" ? "desktop.resolutionMultiple" : "desktop.resolutionHint")}</p>
		</> : null}
		{error ? <p role="alert" className="whitespace-pre-wrap break-words text-destructive">{error}</p> : null}
	</section>;
}
