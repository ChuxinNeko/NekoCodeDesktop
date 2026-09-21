import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { encodeLanPairing, normalizeDesktopAddress } from "../../../../shared/lan-pairing";
import type { LanStatus } from "../../../../shared/lan";
import { useTranslation } from "../../i18n";

export function LanPairingQr({ status }: { status: LanStatus }) {
	const { t } = useTranslation();
	const [selectedUrl, setSelectedUrl] = useState("");
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const urls = status.urls.filter((url) => {
		try { normalizeDesktopAddress(url); return true; } catch { return false; }
	});
	const endpoint = urls.includes(selectedUrl) ? selectedUrl : urls[0];
	const pairing = status.pairing && status.pairing.expiresAt > now ? status.pairing : null;
	const seconds = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
	return <div className="flex flex-col items-center gap-3 py-2">
		{endpoint && pairing ? <>
			<div className="rounded-xl border border-black/10 bg-white p-2">
				<QRCodeSVG value={encodeLanPairing(endpoint, pairing)} size={224} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" title={t("mobile.qrTitle")} />
			</div>
			<p className="text-xs tabular-nums text-muted-foreground">{t("mobile.qrExpires", { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` })}</p>
		</> : <div className="flex min-h-48 w-full max-w-72 items-center justify-center rounded-xl border border-dashed border-border p-5 text-center text-xs leading-relaxed text-muted-foreground">{t(endpoint ? "mobile.qrExpired" : "mobile.noNetwork")}</div>}
		{urls.length > 1 ? <label className="flex w-full flex-col gap-1.5 text-xs text-muted-foreground">{t("mobile.qrAddress")}
			<select className="w-full rounded-md border border-border bg-background px-2 py-2 text-foreground" value={endpoint} onChange={(e) => setSelectedUrl(e.target.value)}>{urls.map((url) => <option key={url} value={url}>{url}</option>)}</select>
		</label> : endpoint ? <code className="select-text text-xs text-muted-foreground">{endpoint}</code> : null}
	</div>;
}
