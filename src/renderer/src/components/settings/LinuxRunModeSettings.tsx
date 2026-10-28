import { useEffect, useState } from "react";
import type { LinuxRunMode, LinuxRunModeStatus } from "../../../../shared/linux-run-mode";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { SettingsRow } from "./SettingsRow";

export function LinuxRunModeSettings() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<LinuxRunModeStatus | null>(null);
	const [selected, setSelected] = useState<LinuxRunMode>("current");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (api.runtime !== "electron") return;
		let alive = true;
		const refresh = () => {
			void api.linuxRunModeStatus().then((value) => {
				if (alive) { setStatus(value); setSelected(value.mode); }
			}).catch((cause: unknown) => { if (alive) setError(errorMessage(cause)); });
		};
		refresh();
		window.addEventListener("focus", refresh);
		return () => { alive = false; window.removeEventListener("focus", refresh); };
	}, []);
	if (api.runtime !== "electron" || status?.platform !== "linux") return null;
	const apply = async () => {
		setBusy(true);
		setError(null);
		try { await api.linuxRunModeApply(selected); }
		catch (cause) { setError(errorMessage(cause)); }
		finally { setBusy(false); }
	};
	return (
		<div>
			<SettingsRow label={t("settings.linuxRunMode")} hint={t("settings.linuxRunMode.hint")}>
				<select aria-label={t("settings.linuxRunMode")} className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
					value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value as LinuxRunMode)}>
					<option value="current" disabled={status.mode === "root" && !status.canReturn}>{t("settings.linuxRunMode.current")}</option>
					<option value="root" disabled={status.mode !== "root" && !status.canElevate}>{t("settings.linuxRunMode.root")}</option>
				</select>
			</SettingsRow>
			<p className="pb-2 text-xs text-muted-foreground">{t("settings.linuxRunMode.active", { user: status.user })}</p>
			{selected === "root" ? <p className="pb-2 text-xs text-amber-600 dark:text-amber-400">{t("settings.linuxRunMode.warning")}</p> : null}
			{status.mode === "current" && status.unavailableReason ? <p className="pb-2 text-xs text-muted-foreground">{t(`settings.linuxRunMode.${status.unavailableReason}`)}</p> : null}
			{status.mode === "root" && !status.canReturn ? <p className="pb-2 text-xs text-muted-foreground">{t("settings.linuxRunMode.noReturn")}</p> : null}
			{selected !== status.mode ? <button type="button" disabled={busy} onClick={() => void apply()}
				className="mb-2 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50">
				{t(busy ? "settings.linuxRunMode.authorizing" : "settings.linuxRunMode.apply")}
			</button> : null}
			{error ? <p role="alert" className="pb-2 text-xs text-destructive">{error}</p> : null}
		</div>
	);
}
