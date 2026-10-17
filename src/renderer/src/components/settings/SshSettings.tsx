import { useEffect, useState } from "react";
import type { SshHost, SshHostInput, SshStatus, SshTestResult } from "../../../../shared/ssh";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { PencilIcon, PlusIcon, TrashCanIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { SshHostDialog } from "./SshHostDialog";
import { SandboxDeploymentStatus, useSandboxDeployments } from "./SandboxDeploymentStatus";

type Probe = { state: "testing" } | { state: "ok"; result: SshTestResult } | { state: "error"; message: string };

const PROBE_DOT: Record<Probe["state"], string> = {
	testing: "bg-[var(--warning,#d97706)] animate-pulse",
	ok: "bg-[var(--success,#16a34a)]",
	error: "bg-destructive",
};

/**
 * The SSH servers the agent and the terminal can reach.
 *
 * A list of what is saved and whether it answers; the connection details are
 * a dialog, filled in once. Sandbox environments are provisioned over SSH.
 */
export function SshSettings() {
	const { t } = useTranslation();
	const deployments = useSandboxDeployments();
	const [status, setStatus] = useState<SshStatus | null>(null);
	const [editing, setEditing] = useState<SshHost | "new" | null>(null);
	const [removing, setRemoving] = useState<SshHost | null>(null);
	const [probes, setProbes] = useState<Record<string, Probe>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.sshStatus().then(setStatus).catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);

	const run = (action: Promise<SshStatus>, after?: (next: SshStatus) => void) => {
		setBusy(true);
		setError(null);
		action
			.then((next) => {
				setStatus(next);
				after?.(next);
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const test = (id: string) => {
		setProbes((value) => ({ ...value, [id]: { state: "testing" } }));
		api
			.sshTest(id)
			.then((result) => {
				setProbes((value) => ({ ...value, [id]: { state: "ok", result } }));
				// A first connection pins the host key; show it.
				void api.sshStatus().then(setStatus);
			})
			.catch((cause: unknown) => setProbes((value) => ({ ...value, [id]: { state: "error", message: errorMessage(cause) } })));
	};

	const save = (input: SshHostInput) =>
		run(api.sshSave(input), (next) => {
			setEditing(null);
			// Check a new or changed host straight away: a typo is cheaper to find now than mid-deploy.
			const saved = input.id ? next.hosts.find((host) => host.id === input.id) : next.hosts.at(-1);
			if (saved) setProbes(current => { const next = { ...current }; delete next[saved.id]; return next; });
			if (saved && saved.desktopMode !== "sandbox") test(saved.id);
		});

	return (
		<section className="flex flex-col gap-4 text-[length:var(--app-font-size-ui,12px)]">
			<p className="leading-relaxed text-muted-foreground">{t("ssh.intro")}</p>

			{error ? (
				<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">
					{error}
				</p>
			) : null}
			{status && !status.canStoreSecrets ? (
				<p className="rounded-lg bg-[var(--warning,#d97706)]/10 p-3 text-xs text-[var(--warning,#d97706)]">{t("ssh.noKeyring")}</p>
			) : null}

			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<h3 className="font-medium">{t("ssh.hosts")}</h3>
					<Button disabled={!status} onClick={() => setEditing("new")} size="sm" variant="chrome-outline">
						<PlusIcon className="size-3.5" />
						{t("ssh.add")}
					</Button>
				</div>
				{status && !status.hosts.length ? (
					<p className="rounded-lg border border-dashed border-[color:var(--app-surface-divider)] px-3 py-6 text-center text-xs text-muted-foreground/70">
						{t("ssh.empty")}
					</p>
				) : null}
				{status?.hosts.map((host) => {
					const probe = probes[host.id];
					const deployment = host.desktopMode === "sandbox" ? deployments[host.id] : undefined;
					const deploying = !!deployment && !["ready", "error"].includes(deployment.phase);
					const dot = deployment ? PROBE_DOT[deployment.phase === "ready" ? "ok" : deployment.phase === "error" ? "error" : "testing"] : probe ? PROBE_DOT[probe.state] : "bg-muted-foreground/40";
					return (
						<div key={host.id} className="flex flex-col gap-1.5 rounded-lg bg-muted/40 p-3">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span
											aria-hidden="true"
											className={cn("size-2 shrink-0 rounded-full", dot)}
										/>
										<span className="truncate">{host.name}</span>
										<span className="truncate font-mono text-xs text-muted-foreground">
											{host.username}@{host.host}{host.port !== 22 ? `:${host.port}` : ""}
										</span>
									</div>
									<p className="mt-1 truncate text-xs text-muted-foreground">
										{t(`ssh.auth.${host.auth}`)}
										{host.desktopMode === "sandbox" ? ` · ${t("ssh.desktop.sandbox")}` : host.remoteDir ? ` · ${host.remoteDir}` : ""}
										{host.vncPort ? ` · VNC :${host.vncPort}` : ""}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<Button
										disabled={busy || probe?.state === "testing" || deploying}
										onClick={() => test(host.id)}
										size="xs"
										variant="subtle"
									>
										{t(probe?.state === "testing" ? "ssh.testing" : "ssh.test")}
									</Button>
									<Button
										aria-label={t("ssh.edit")}
										disabled={busy}
										onClick={() => setEditing(host)}
										size="icon-xs"
										title={t("ssh.edit")}
										variant="ghost"
									>
										<PencilIcon className="size-3.5" />
									</Button>
									<Button
										aria-label={t("ssh.remove")}
										disabled={busy}
										onClick={() => setRemoving(host)}
										size="icon-xs"
										title={t("ssh.remove")}
										variant="ghost"
									>
										<TrashCanIcon className="size-3.5" />
									</Button>
								</div>
							</div>
							{probe?.state === "ok" ? (
								<p className="text-xs text-[var(--success,#16a34a)]">
									{t("ssh.connected")}{probe.result.system ? ` · ${probe.result.system}` : ""}
								</p>
							) : probe?.state === "error" ? (
								<p className="break-words text-xs text-destructive">{probe.message}</p>
							) : null}
							{host.desktopMode === "sandbox" ? <SandboxDeploymentStatus state={deployments[host.id]} /> : null}
							{host.fingerprint ? (
								<div className="flex items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
									<span className="shrink-0">{t("ssh.hostKey")}</span>
									<code className="min-w-0 select-text truncate font-mono">{host.fingerprint}</code>
									<Button
										className="shrink-0"
										disabled={busy}
										onClick={() => run(api.sshForgetHostKey(host.id))}
										size="xs"
										title={t("ssh.forgetHostKeyHint")}
										variant="ghost"
									>
										{t("ssh.forgetHostKey")}
									</Button>
								</div>
							) : null}
						</div>
					);
				})}
			</section>

			<p className="border-t border-[color:var(--app-surface-divider)] pt-4 text-xs leading-relaxed text-muted-foreground">
				{t("ssh.usageHint")}
			</p>

			{editing && status ? (
				<SshHostDialog
					busy={busy}
					canStoreSecrets={status.canStoreSecrets}
					host={editing === "new" ? undefined : editing}
					onClose={() => setEditing(null)}
					onSave={save}
				/>
			) : null}

			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setRemoving(null);
				}}
				title={t("ssh.removeTitle", { name: removing?.name ?? "" })}
				description={t("ssh.removeDescription")}
				footer={
					<>
						<Button disabled={busy} onClick={() => setRemoving(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button
							disabled={busy}
							onClick={() => removing && run(api.sshRemove(removing.id), () => setRemoving(null))}
							size="sm"
							variant="destructive"
						>
							{t("common.delete")}
						</Button>
					</>
				}
			/>
		</section>
	);
}
