import { useEffect, useRef, useState } from "react";
import type { LanStatus } from "../../../../shared/lan";
import type { RelayStatus } from "../../../../shared/relay";
import { api, errorMessage } from "../../api";
import { useHostDirectoryPicker } from "../HostDirectoryPicker";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { LanPairingQr } from "./LanPairingQr";
import { RelayLoginDialog } from "./RelayLoginDialog";

const relayIndicator: Record<RelayStatus["state"], string> = {
	ready: "bg-emerald-500",
	connecting: "bg-amber-500",
	error: "bg-red-500",
	"signed-out": "bg-muted-foreground/50",
};

export function MobileSettings() {
	const { t } = useTranslation();
	const pickDirectory = useHostDirectoryPicker();
	const [status, setStatus] = useState<LanStatus | null>(null);
	const [relay, setRelay] = useState<RelayStatus | null>(null);
	const [loginOpen, setLoginOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef(0);
	useEffect(() => {
		let disposed = false;
		const load = async () => {
			const version = ++request.current;
			try { const next = await api.lanStatus(); if (!disposed && version === request.current) setStatus(next); }
			catch (e) { if (!disposed) setError(errorMessage(e)); }
		};
		void load();
		const timer = setInterval(load, 3000);
		return () => { disposed = true; clearInterval(timer); };
	}, []);
	useEffect(() => {
		let disposed = false;
		void api.relayStatus().then((next) => { if (!disposed) setRelay(next); }).catch((e) => { if (!disposed) setError(errorMessage(e)); });
		return api.onRelayChanged(setRelay);
	}, []);
	const addProject = async (): Promise<LanStatus> => {
		const path = await pickDirectory(api.homeDir);
		if (!path) return status ?? api.lanStatus();
		return api.lanAddProjectPath(path);
	};
	const action = async (run: () => Promise<LanStatus>) => {
		setBusy(true); setError(null); ++request.current;
		try { const next = await run(); ++request.current; setStatus(next); }
		catch (e) { setError(errorMessage(e)); }
		finally { setBusy(false); }
	};
	const relayAction = async (run: () => Promise<RelayStatus>) => {
		setBusy(true); setError(null);
		try { setRelay(await run()); }
		catch (e) { setError(errorMessage(e)); }
		finally { setBusy(false); }
	};
	const authenticate = async (run: () => Promise<RelayStatus>) => {
		setError(null);
		const next = await run();
		setRelay(next);
		setLoginOpen(false);
	};
	return <div className="flex flex-col gap-5 text-[length:var(--app-font-size-ui,12px)]">
		<p className="leading-relaxed text-muted-foreground">{t("mobile.intro")}</p>
		{error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">{error}</p>}
		<section className="flex flex-col gap-3 rounded-xl border border-[color:var(--app-surface-divider)] p-4">
			<div className="flex items-center justify-between gap-4">
				<div>
					<div className="font-medium">{t("mobile.publicAccess")}</div>
					<p className="mt-1 text-xs text-muted-foreground">{t("mobile.publicIntro")}</p>
				</div>
				{!relay?.account && <Button disabled={busy} onClick={() => setLoginOpen(true)} size="sm">{t("mobile.publicLogin")}</Button>}
			</div>
			{relay?.account && <div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<span className={`size-2 shrink-0 rounded-full ${relayIndicator[relay.state]}`} />
					<div className="min-w-0">
						<div className="truncate">{relay.account.email}</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{t(`mobile.publicState.${relay.state}`)}{relay.state === "error" && relay.error ? `：${relay.error}` : ""}
						</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button disabled={busy} size="xs" variant="subtle" onClick={() => relayAction(api.relayReconnect)}>{t("mobile.publicReconnect")}</Button>
					<Button disabled={busy} size="xs" variant="ghost" onClick={() => relayAction(api.relayLogout)}>{t("mobile.publicLogout")}</Button>
				</div>
			</div>}
			{relay?.device && <p className="break-all font-mono text-xs text-muted-foreground">{t("mobile.publicDevice")}: {relay.device.name} · {relay.device.id}</p>}
			<p className="text-xs leading-relaxed text-muted-foreground">{t("mobile.publicSecurity")}</p>
		</section>
		{loginOpen && <RelayLoginDialog
			onClose={() => setLoginOpen(false)}
			onLogin={(request) => authenticate(() => api.relayLogin(request))}
			onVerify={(request) => authenticate(() => api.relayVerify(request))}
			onRegister={(request) => api.relayRegister(request)}
			onResend={(request) => api.relayResend(request)}
		/>}
		<div className="flex items-center justify-between gap-4 rounded-xl border border-[color:var(--app-surface-divider)] p-4">
			<div><div>{t("mobile.access")}</div><p className="mt-1 text-xs text-muted-foreground">{t(status?.enabled ? "mobile.on" : "mobile.off")}</p></div>
			<Button disabled={!status || busy} onClick={() => action(() => api.lanSetEnabled(!status?.enabled))} size="sm" variant={status?.enabled ? "subtle" : "default"}>{t(status?.enabled ? "mobile.disable" : "mobile.enable")}</Button>
		</div>
		{status?.enabled && <section className="flex flex-col gap-3 rounded-xl border border-[color:var(--app-surface-divider)] p-4">
			<h3 className="font-medium">{t("mobile.connect")}</h3>
			<p className="text-xs leading-relaxed text-muted-foreground">{t("mobile.connectHint")}</p>
			<LanPairingQr status={status} />
			<Button disabled={busy} size="sm" variant="subtle" onClick={() => action(api.lanPairing)}>{t("mobile.newCode")}</Button>
			<details className="rounded-lg border border-[color:var(--app-surface-divider)] p-3">
			<summary className="cursor-pointer text-xs text-muted-foreground">{t("mobile.manualDetails")}</summary>
			<div className="mt-3 flex flex-col gap-3">
			{status.urls.length ? status.urls.map((url) => <div key={url} className="flex items-center justify-between gap-2"><code className="select-text break-all rounded bg-muted px-2 py-1.5">{url}</code><Button size="xs" variant="subtle" onClick={() => { void navigator.clipboard.writeText(url).catch((e) => setError(errorMessage(e))); }}>{t("mobile.copy")}</Button></div>) : <p className="text-muted-foreground">{t("mobile.noNetwork")}</p>}
			<div className="mt-2 flex flex-wrap items-center justify-between gap-3">
				<div><p className="text-xs text-muted-foreground">{t("mobile.code")}</p><p className="mt-1 select-text font-mono text-2xl tracking-[0.16em]">{status.pairing?.code ?? "—"}</p></div>
			</div><p className="text-xs text-muted-foreground">{t("mobile.codeHint")}</p>
			</div></details>
		</section>}
		<section className="flex flex-col gap-3">
			<div className="flex items-center justify-between"><h3 className="font-medium">{t("mobile.projects")}</h3><Button size="xs" variant="subtle" disabled={busy} onClick={() => action(addProject)}>{t("mobile.addProject")}</Button></div>
			<p className="text-xs leading-relaxed text-muted-foreground">{t("mobile.projectsHint")}</p>
			{status?.projects.map((project) => <div key={project.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3"><div className="min-w-0"><div>{project.name}</div><p className="mt-1 break-all text-xs text-muted-foreground">{project.path}</p></div><Button disabled={busy} size="xs" variant="ghost" onClick={() => action(() => api.lanRemoveProject(project.id))}>{t("mobile.remove")}</Button></div>)}
		</section>
		<section className="flex flex-col gap-3">
			<h3 className="font-medium">{t("mobile.devices")}</h3>
			{!status?.devices.length && <p className="text-xs text-muted-foreground">{t("mobile.noDevices")}</p>}
			{status?.devices.map((device) => <div key={device.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3"><div><div>{device.name}</div><p className="mt-1 text-xs text-muted-foreground">{new Date(device.pairedAt).toLocaleString()}</p></div><Button disabled={busy} size="xs" variant="ghost" onClick={() => action(() => api.lanRevoke(device.id))}>{t("mobile.revoke")}</Button></div>)}
		</section>
		<p className="border-t border-[color:var(--app-surface-divider)] pt-4 text-xs leading-relaxed text-muted-foreground">{t("mobile.networkHint")}</p>
	</div>;
}
