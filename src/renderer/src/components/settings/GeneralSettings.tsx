import { useEffect, useState } from "react";
import type { ProxyStatus } from "../../../../shared/settings";
import type { AppPreferences, CommandShellId, CommandShellOption } from "../../../../shared/preferences";
import { api, errorMessage } from "../../api";
import { LANGUAGE_OPTIONS, useTranslation, type TranslationKey } from "../../i18n";
import { cn, getNavigatorPlatform, isWindowsPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";

const COMMAND_SHELL_KEYS: Record<CommandShellId, TranslationKey> = {
	auto: "settings.commandShell.auto",
	powershell: "settings.commandShell.powershell",
	pwsh: "settings.commandShell.pwsh",
	cmd: "settings.commandShell.cmd",
	"git-bash": "settings.commandShell.gitBash",
	bash: "settings.commandShell.bash",
	zsh: "settings.commandShell.zsh",
	sh: "settings.commandShell.sh",
};

/**
 * Which shell the agent's commands run in. Every shell the platform knows is
 * listed; one that is not installed is shown but cannot be picked, so the
 * list says what exists rather than hiding it.
 */
function CommandShellRow({
	value,
	onChange,
}: {
	value: CommandShellId | undefined;
	onChange: (value: CommandShellId) => void;
}) {
	const { t } = useTranslation();
	const [shells, setShells] = useState<CommandShellOption[] | null>(null);
	useEffect(() => {
		api
			.preferencesCommandShells()
			.then(setShells)
			.catch(() => setShells([]));
	}, []);
	const selected = shells?.find((shell) => shell.id === value);
	// Chosen once, since uninstalled: new sessions fall back to automatic.
	const missing = !!value && value !== "auto" && !!shells && !selected?.path;
	return (
		<div className="flex flex-col gap-1.5 py-2.5">
			<div className="flex items-center justify-between gap-4">
				<div className="flex min-w-0 flex-col">
					<span className="text-[length:var(--app-font-size-ui,12px)]">{t("settings.commandShell")}</span>
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t("settings.commandShellHint")}
					</span>
				</div>
				<Select
					value={value ?? "auto"}
					disabled={!value || !shells}
					onValueChange={(next) => {
						if (next) onChange(next as CommandShellId);
					}}
				>
					<SelectTrigger size="sm" className="w-52 shrink-0">
						<SelectValue>{t(COMMAND_SHELL_KEYS[value ?? "auto"])}</SelectValue>
					</SelectTrigger>
					<SelectPopup surface="settings">
						{(shells ?? []).map((shell) => (
							<SelectItem key={shell.id} value={shell.id} disabled={shell.id !== "auto" && !shell.path}>
								{t(COMMAND_SHELL_KEYS[shell.id])}
								{shell.id !== "auto" && !shell.path ? ` · ${t("settings.commandShellMissing")}` : ""}
							</SelectItem>
						))}
					</SelectPopup>
				</Select>
			</div>
			{selected?.path ? (
				<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground" title={selected.path}>
					{selected.path}
				</span>
			) : null}
			{missing ? (
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]">
					{t("settings.commandShellFallback")}
				</span>
			) : null}
		</div>
	);
}

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

			{/* The agent runs every command through this; it is picked before the rest is tuned. */}
			<CommandShellRow value={preferences?.commandShell} onChange={(commandShell) => setPreference({ commandShell })} />

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

			{/* The driver behind it is Windows-only for now; see src/main/computer/service.ts. */}
			{isWindowsPlatform(getNavigatorPlatform()) ? (
				<SettingsRow hint={t("settings.computerUseHint")} label={t("settings.computerUse")}>
					<Switch
						checked={preferences?.computerUse ?? false}
						disabled={!preferences}
						onCheckedChange={(checked: boolean) => setPreference({ computerUse: checked })}
					/>
				</SettingsRow>
			) : null}

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
