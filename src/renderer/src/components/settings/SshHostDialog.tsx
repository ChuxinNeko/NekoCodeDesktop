import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import { SSH_DEFAULT_PORT, type SshAuthMethod, type SshHost, type SshHostInput } from "../../../../shared/ssh";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { FolderOpenIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Add or edit one SSH server.
 *
 * The password field starts empty even when one is saved — main never sends
 * it back — and an empty field on an existing host means "keep it", so
 * renaming a host does not ask for the password again.
 */
export function SshHostDialog({
	host,
	busy,
	canStoreSecrets,
	onClose,
	onSave,
}: {
	/** The host being edited; absent to add one. */
	host?: SshHost;
	busy: boolean;
	canStoreSecrets: boolean;
	onClose: () => void;
	onSave: (input: SshHostInput) => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState({
		name: host?.name ?? "",
		host: host?.host ?? "",
		port: String(host?.port ?? SSH_DEFAULT_PORT),
		username: host?.username ?? "",
		auth: host?.auth ?? ("password" as SshAuthMethod),
		privateKeyPath: host?.privateKeyPath ?? "",
		remoteDir: host?.remoteDir ?? "",
		secret: "",
		desktop: host?.desktopMode === "sandbox" || !host ? ("sandbox" as const) : host?.vncPort ? ("vnc" as const) : ("auto" as const),
		sandboxDir: host?.sandboxDir ?? "/home/neko/workspace",
		vncPort: String(host?.vncPort ?? 5901),
		vncPassword: "",
	});
	const field = (key: "name" | "host" | "port" | "username" | "privateKeyPath" | "remoteDir" | "secret" | "vncPort" | "vncPassword" | "sandboxDir") => ({
		value: draft[key],
		onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: event.target.value }),
	});
	// Switching an existing password host to a key (or back) keeps nothing that belonged to the other method.
	const keepsSecret = !!host?.hasSecret && host.auth === draft.auth;
	const port = Number(draft.port);
	const vncPort = Number(draft.vncPort);
	const keepsVncPassword = !!host?.hasVncPassword && draft.desktop === "vnc";
	const complete =
		!!draft.host.trim() &&
		!!draft.username.trim() &&
		Number.isInteger(port) && port >= 1 && port <= 65535 &&
		(draft.desktop !== "vnc" || (Number.isInteger(vncPort) && vncPort >= 1 && vncPort <= 65535)) &&
		(draft.desktop !== "sandbox" || draft.sandboxDir.startsWith("/")) &&
		(draft.auth === "password" ? keepsSecret || !!draft.secret : !!draft.privateKeyPath.trim());

	const submit = () => {
		const secret = draft.secret
			? draft.secret
			: keepsSecret ? undefined : "";
		onSave({
			...(host ? { id: host.id } : {}),
			name: draft.name,
			host: draft.host,
			port,
			username: draft.username,
			auth: draft.auth,
			privateKeyPath: draft.auth === "key" ? draft.privateKeyPath : null,
			remoteDir: draft.remoteDir || null,
			...(secret !== undefined ? { secret } : {}),
			vncPort: draft.desktop === "vnc" ? vncPort : null,
			desktopMode: draft.desktop === "sandbox" ? "sandbox" : "host",
			sandboxDir: draft.sandboxDir,
			// Empty keeps a saved VNC password; there is no way to clear one short of switching to automatic.
			...(draft.desktop === "vnc" && (draft.vncPassword || !keepsVncPassword) ? { vncPassword: draft.vncPassword } : {}),
		});
	};

	const hint = "text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground";

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					className={cn(
						"fixed left-1/2 top-1/2 z-50 flex max-h-[min(36rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
						"flex-col gap-3 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						"w-[32rem] max-w-[calc(100vw-3rem)]",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<Dialog.Title className="shrink-0 text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
						{t(host ? "ssh.editTitle" : "ssh.addTitle")}
					</Dialog.Title>

					<form
						className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
						onSubmit={(event) => {
							event.preventDefault();
							if (complete && !busy) submit();
						}}
					>
						<div className="flex gap-2">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<Label>{t("ssh.host")}</Label>
								<Input autoFocus className="font-mono" placeholder="203.0.113.10" {...field("host")} />
							</div>
							<div className="flex w-24 flex-col gap-1">
								<Label>{t("ssh.port")}</Label>
								<Input className="font-mono" inputMode="numeric" {...field("port")} />
							</div>
						</div>
						<div className="flex flex-col gap-1">
							<Label>{t("ssh.username")}</Label>
							<Input className="font-mono" placeholder="root" {...field("username")} />
						</div>

						<div className="flex flex-col gap-1.5">
							<Label>{t("ssh.auth")}</Label>
							<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
								{(["password", "key"] as const).map((auth) => (
									<button
										key={auth}
										type="button"
										onClick={() => setDraft({ ...draft, auth, secret: "" })}
										className={cn(
											"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
											draft.auth === auth
												? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{t(`ssh.auth.${auth}`)}
									</button>
								))}
							</div>
						</div>

						{draft.auth === "password" ? (
							<div className="flex flex-col gap-1">
								<Label>{t("ssh.password")}</Label>
								<Input
									className="font-mono"
									type="password"
									autoComplete="off"
									placeholder={keepsSecret ? t("ssh.passwordUnchanged") : undefined}
									{...field("secret")}
								/>
								{!canStoreSecrets ? <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{t("ssh.noKeyring")}</p> : null}
							</div>
						) : (
							<>
								<div className="flex flex-col gap-1">
									<Label>{t("ssh.keyPath")}</Label>
									<div className="flex items-center gap-2">
										<Input className="min-w-0 flex-1 font-mono" placeholder="~/.ssh/id_ed25519" {...field("privateKeyPath")} />
										{api.runtime !== "web" ? (
											<Button
												onClick={() => {
													void api.sshChooseKey().then((path) => {
														if (path) setDraft((value) => ({ ...value, privateKeyPath: path }));
													});
												}}
												size="sm"
												type="button"
												variant="chrome-outline"
											>
												<FolderOpenIcon className="size-3.5" />
												{t("ssh.browse")}
											</Button>
										) : null}
									</div>
								</div>
								<div className="flex flex-col gap-1">
									<Label>{t("ssh.passphrase")}</Label>
									<Input
										className="font-mono"
										type="password"
										autoComplete="off"
										placeholder={keepsSecret ? t("ssh.passwordUnchanged") : t("ssh.optional")}
										{...field("secret")}
									/>
								</div>
							</>
						)}

						<div className="flex flex-col gap-1">
							<Label>{t(draft.desktop === "sandbox" ? "ssh.sandboxDir" : "ssh.remoteDir")}</Label>
							<Input className="font-mono" placeholder={draft.desktop === "sandbox" ? "/home/neko/workspace" : "/srv/my-app"} {...field(draft.desktop === "sandbox" ? "sandboxDir" : "remoteDir")} />
							<p className={hint}>{t(draft.desktop === "sandbox" ? "ssh.sandboxDirHint" : "ssh.remoteDirHint")}</p>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>{t("ssh.desktop")}</Label>
							<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
								{(["sandbox", "auto", "vnc"] as const).map((mode) => (
									<button
										key={mode}
										type="button"
										onClick={() => setDraft({ ...draft, desktop: mode })}
										className={cn(
											"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
											draft.desktop === mode
												? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{t(`ssh.desktop.${mode}`)}
									</button>
								))}
							</div>
							{draft.desktop === "sandbox" ? (
								<div className="flex flex-col gap-2">
									<p className={hint}>{t("ssh.desktop.sandboxHint")}</p>
									<p className="rounded-lg bg-muted/50 p-2 text-xs leading-relaxed text-muted-foreground">{t("ssh.sandboxRequirements")}</p>
								</div>
							) : draft.desktop === "auto" ? (
								<p className={hint}>{t("ssh.desktop.autoHint")}</p>
							) : (
								<div className="flex gap-2">
									<div className="flex w-24 flex-col gap-1">
										<Label>{t("ssh.vncPort")}</Label>
										<Input className="font-mono" inputMode="numeric" {...field("vncPort")} />
									</div>
									<div className="flex min-w-0 flex-1 flex-col gap-1">
										<Label>{t("ssh.vncPassword")}</Label>
										<Input
											className="font-mono"
											type="password"
											autoComplete="off"
											placeholder={keepsVncPassword ? t("ssh.passwordUnchanged") : t("ssh.optional")}
											{...field("vncPassword")}
										/>
									</div>
								</div>
							)}
						</div>
						<div className="flex flex-col gap-1">
							<Label>{t("ssh.name")}</Label>
							<Input placeholder={draft.username && draft.host ? `${draft.username}@${draft.host}` : t("ssh.optional")} {...field("name")} />
							<p className={hint}>{t("ssh.nameHint")}</p>
						</div>
						{/* Enter submits from any field. */}
						<button type="submit" hidden />
					</form>

					<div className="flex shrink-0 items-center justify-end gap-2">
						<Button onClick={onClose} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button disabled={busy || !complete} onClick={submit} size="sm" variant="subtle">
							{t("common.save")}
						</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
