import { useEffect, useState } from "react";
import type { WebUiHost, WebUiStatus } from "../../../../shared/webui";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";

const HOSTS: WebUiHost[] = ["localhost", "0.0.0.0"];

export function WebUiSettings() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<WebUiStatus | null>(null);
	const [host, setHost] = useState<WebUiHost>("localhost");
	const [port, setPort] = useState("");
	const [password, setPassword] = useState("");
	const [securePathEnabled, setSecurePathEnabled] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		api
			.webUiStatus()
			.then((next) => {
				if (disposed) return;
				setStatus(next);
				setHost(next.host);
				setPort(next.configuredPort === null ? "" : String(next.configuredPort));
				setSecurePathEnabled(next.securePathEnabled);
			})
			.catch((cause: unknown) => {
				if (!disposed) setError(errorMessage(cause));
			});
		return () => {
			disposed = true;
		};
	}, []);

	const selectHost = async (nextHost: WebUiHost) => {
		if (!status || busy || nextHost === host) return;
		setHost(nextHost);
		if (!status.enabled) return;
		setBusy(true);
		setError(null);
		try {
			const next = await api.webUiSave({
				enabled: true,
				host: nextHost,
				port: status.configuredPort,
				securePathEnabled: status.securePathEnabled,
			});
			setStatus(next);
			setHost(next.host);
		} catch (cause) {
			setHost(status.host);
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const save = async (enabled: boolean) => {
		setBusy(true);
		setError(null);
		const trimmed = port.trim();
		const parsed = trimmed === "" ? null : Number(trimmed);
		if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)) {
			setError(t("webui.errorPort"));
			setBusy(false);
			return;
		}
		if (enabled && !status?.hasPassword && password === "") {
			setError(t("webui.errorPasswordRequired"));
			setBusy(false);
			return;
		}
		if (password !== "" && (password.length < 8 || password.length > 128)) {
			setError(t("webui.errorPasswordLength"));
			setBusy(false);
			return;
		}
		try {
			const next = await api.webUiSave({
				enabled,
				host,
				port: parsed,
				securePathEnabled,
				...(password === "" ? {} : { password }),
			});
			setStatus(next);
			setHost(next.host);
			setSecurePathEnabled(next.securePathEnabled);
			setPassword("");
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-5 text-[length:var(--app-font-size-ui,12px)]">
			<p className="leading-relaxed text-muted-foreground">{t("webui.intro")}</p>
			{error ? (
				<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">
					{error}
				</p>
			) : null}
			<section className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-[color:var(--app-surface-divider)] px-4">
				<SettingsRow hint={t("webui.hostHint")} label={t("webui.host")}>
					<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
						{HOSTS.map((entry) => (
							<button
								key={entry}
								type="button"
								disabled={!status || busy}
								onClick={() => void selectHost(entry)}
								className={cn(
									"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors disabled:pointer-events-none disabled:opacity-50",
									host === entry
										? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{t(entry === "localhost" ? "webui.hostLocalhost" : "webui.hostNetwork")}
							</button>
						))}
					</div>
				</SettingsRow>
				<SettingsRow hint={t("webui.portHint")} label={t("webui.port")}>
					<Input
						className="w-28"
						placeholder={t("webui.portPlaceholder")}
						value={port}
						disabled={!status || busy}
						onChange={(event) => setPort(event.target.value)}
					/>
				</SettingsRow>
				<SettingsRow
					hint={t(status?.hasPassword ? "webui.passwordKeepHint" : "webui.passwordHint")}
					label={t("webui.password")}
				>
					<Input
						className="w-44"
						type="password"
						placeholder={t(status?.hasPassword ? "webui.passwordKeep" : "webui.passwordPlaceholder")}
						value={password}
						disabled={!status || busy}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</SettingsRow>
				<SettingsRow hint={t("webui.securePathHint")} label={t("webui.securePath")}>
					<Switch
						checked={securePathEnabled}
						disabled={!status || busy}
						onCheckedChange={(checked: boolean) => setSecurePathEnabled(checked)}
					/>
				</SettingsRow>
			</section>
			{host === "0.0.0.0" ? (
				<p className="rounded-lg bg-[var(--warning)]/10 p-3 text-xs leading-relaxed text-[var(--warning)]">
					{t("webui.networkWarning")}
				</p>
			) : null}
			<p className="text-xs leading-relaxed text-muted-foreground">{t("webui.httpWarning")}</p>
			<div className="flex items-center gap-2">
				<Button
					size="sm"
					variant="subtle"
					disabled={!status || busy}
					onClick={() => void save(status?.enabled ?? false)}
				>
					{t("common.save")}
				</Button>
				{status?.enabled ? (
					<>
						{!status.running ? (
							<Button size="sm" disabled={busy} onClick={() => void save(true)}>
								{t("webui.retry")}
							</Button>
						) : null}
						<Button size="sm" variant="chrome-outline" disabled={busy} onClick={() => void save(false)}>
							{t("webui.stop")}
						</Button>
					</>
				) : (
					<Button size="sm" disabled={!status || busy} onClick={() => void save(true)}>
						{t("webui.enable")}
					</Button>
				)}
			</div>
			{status ? (
				<section className="flex flex-col gap-3 rounded-xl border border-[color:var(--app-surface-divider)] p-4">
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"size-2 shrink-0 rounded-full",
								status.running ? "bg-emerald-500" : status.enabled ? "bg-amber-500" : "bg-muted-foreground/50",
							)}
						/>
						<span>
							{t(
								status.running
									? "webui.stateRunning"
									: status.enabled
										? "webui.stateEnabled"
										: "webui.stateStopped",
							)}
							{status.port !== null ? ` · :${status.port}` : ""}
						</span>
					</div>
					{status.error ? (
						<p className="text-xs text-destructive">{status.error}</p>
					) : null}
					{status.urls.length ? (
						<div className="flex flex-col gap-2">
							<span className="text-xs text-muted-foreground">{t("webui.urls")}</span>
							{status.urls.map((url) => (
								<div key={url} className="flex items-center justify-between gap-2">
									<code className="select-text break-all rounded bg-muted px-2 py-1.5">{url}</code>
									<Button
										size="xs"
										variant="subtle"
										onClick={() => {
											void navigator.clipboard.writeText(url).catch((cause) => setError(errorMessage(cause)));
										}}
									>
										{t("webui.copy")}
									</Button>
								</div>
							))}
						</div>
					) : null}
				</section>
			) : null}
		</div>
	);
}
