import { useEffect, useState } from "react";
import type { ProxyStatus } from "../../../../shared/settings";
import type { AppPreferences } from "../../../../shared/preferences";
import { api, errorMessage } from "../../api";
import { LANGUAGE_OPTIONS, useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";

const PROXY_SOURCE_KEYS: Record<ProxyStatus["source"], TranslationKey> = {
	manual: "settings.proxy.source.manual",
	environment: "settings.proxy.source.environment",
	system: "settings.proxy.source.system",
	none: "settings.proxy.direct",
};

export function GeneralSettings() {
	const { language, setLanguage, t } = useTranslation();
	const [proxy, setProxy] = useState<ProxyStatus | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [preferences, setPreferences] = useState<AppPreferences | null>(null);

	useEffect(() => {
		api
			.preferencesGet()
			.then(setPreferences)
			.catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);

	const setPreference = (patch: Partial<AppPreferences>) => {
		// Optimistic: a switch that waits for a round trip before moving reads as
		// broken. The reply is authoritative and puts it back if the write failed.
		setPreferences((current) => (current ? { ...current, ...patch } : current));
		api
			.preferencesUpdate(patch)
			.then(setPreferences)
			.catch((cause: unknown) => setError(errorMessage(cause)));
	};

	useEffect(() => {
		api
			.proxyStatus()
			.then((status) => {
				setProxy(status);
				setDraft(status.manual ?? "");
			})
			.catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);

	const save = (manual: string | null) => {
		setBusy(true);
		setError(null);
		api
			.proxySave(manual)
			.then((status) => {
				setProxy(status);
				setDraft(status.manual ?? "");
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	return (
		<section className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
			<SettingsRow hint={t("settings.languageHint")} label={t("settings.language")}>
				<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
					{LANGUAGE_OPTIONS.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setLanguage(entry.id)}
							className={cn(
								"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								language === entry.id
									? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{entry.label}
						</button>
					))}
				</div>
			</SettingsRow>

			<SettingsRow hint={t("settings.notifyOnTaskFinishHint")} label={t("settings.notifyOnTaskFinish")}>
				<Switch
					checked={preferences?.notifyOnTaskFinish ?? false}
					disabled={!preferences}
					onCheckedChange={(checked: boolean) => setPreference({ notifyOnTaskFinish: checked })}
				/>
			</SettingsRow>

			<SettingsRow hint={t("settings.isolateBackgroundHint")} label={t("settings.isolateBackground")}>
				<Switch
					checked={preferences?.isolateBackgroundTasks ?? false}
					disabled={!preferences}
					onCheckedChange={(checked: boolean) => setPreference({ isolateBackgroundTasks: checked })}
				/>
			</SettingsRow>

			<div className="flex flex-col gap-2 py-2.5">
				<div className="flex min-w-0 flex-col">
					<span className="text-[length:var(--app-font-size-ui,12px)]">{t("settings.proxy")}</span>
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t("settings.proxyHint")}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<Input
						className="min-w-0 flex-1"
						placeholder={t("settings.proxyPlaceholder")}
						value={draft ?? ""}
						disabled={draft === null || busy}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || draft === null) return;
							save(draft.trim() ? draft : null);
						}}
					/>
					<Button
						onClick={() => draft !== null && save(draft.trim() ? draft : null)}
						size="sm"
						variant="subtle"
						disabled={draft === null || busy || (proxy?.manual ?? "") === draft}
					>
						{t("common.save")}
					</Button>
					{proxy?.manual !== null && proxy?.manual !== undefined ? (
						<Button onClick={() => save(null)} size="sm" variant="chrome-outline" disabled={busy}>
							{t("settings.proxyAuto")}
						</Button>
					) : null}
				</div>
				{proxy ? (
					// A direct connection is worth stating: on a network that needs a
					// proxy, silence here is what makes the failure look like a bug.
					<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{proxy.url ? `${proxy.url} · ` : ""}
						{t(PROXY_SOURCE_KEYS[proxy.source])}
					</span>
				) : null}
				{proxy?.warning ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]">
						{proxy.warning}
					</span>
				) : null}
				{error ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span>
				) : null}
			</div>
		</section>
	);
}
