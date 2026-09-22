import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import type { QqBotConfig, QqBotProtocol } from "../../../../shared/qqbot";
import { useTranslation } from "../../i18n";
import { FolderOpenIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/**
 * Where the QQ connection is configured.
 *
 * A dialog rather than fields down the settings page: this is a form that is
 * filled in once and then left alone, and leaving it open would push the things
 * the page exists to show — whether the bot is connected, who is paired, what it
 * has been doing — below the fold behind a credential nobody rereads.
 *
 * The two protocols are not two addresses for one thing. A self-hosted OneBot
 * backend and the official platform differ in credentials, in what events they
 * deliver, and in who their ids identify, so the switch swaps the whole field
 * set rather than relabelling one.
 */
export function QqBotDialog({
	config,
	busy,
	onClose,
	onSave,
	onChooseProject,
}: {
	config: QqBotConfig;
	busy: boolean;
	onClose: () => void;
	onSave: (config: QqBotConfig) => void;
	/** Resolves to the chosen directory, or null if the picker was cancelled. */
	onChooseProject: () => Promise<string | null>;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<QqBotConfig>(config);

	const field = (key: "url" | "accessToken" | "appId" | "appSecret") => ({
		value: draft[key],
		onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: event.target.value }),
	});

	const complete =
		draft.protocol === "onebot" ? !!draft.url.trim() : !!draft.appId.trim() && !!draft.appSecret.trim();

	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					className={cn(
						"fixed left-1/2 top-1/2 z-50 flex max-h-[min(34rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
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
						{t("qqbot.dialogTitle")}
					</Dialog.Title>

					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
						<div className="flex flex-col gap-1.5">
							<Label>{t("qqbot.protocol")}</Label>
							<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
								{(["onebot", "official"] as const).map((protocol: QqBotProtocol) => (
									<button
										key={protocol}
										type="button"
										onClick={() => setDraft({ ...draft, protocol })}
										className={cn(
											"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
											draft.protocol === protocol
												? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{t(`qqbot.protocol.${protocol}`)}
									</button>
								))}
							</div>
							<p className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
								{t(`qqbot.protocol.${draft.protocol}.hint`)}
							</p>
						</div>

						{draft.protocol === "onebot" ? (
							<>
								<div className="flex flex-col gap-1">
									<Label>{t("qqbot.url")}</Label>
									<Input className="font-mono" placeholder="ws://127.0.0.1:3001" {...field("url")} />
								</div>
								<div className="flex flex-col gap-1">
									<Label>{t("qqbot.accessToken")}</Label>
									<Input
										className="font-mono"
										type="password"
										placeholder={t("qqbot.optional")}
										{...field("accessToken")}
									/>
								</div>
							</>
						) : (
							<>
								<div className="flex flex-col gap-1">
									<Label>{t("qqbot.appId")}</Label>
									<Input className="font-mono" placeholder="102xxxxxxx" {...field("appId")} />
								</div>
								<div className="flex flex-col gap-1">
									<Label>{t("qqbot.appSecret")}</Label>
									<Input className="font-mono" type="password" {...field("appSecret")} />
								</div>
								<label className="flex items-center justify-between gap-3">
									<span className="min-w-0">
										<span className="block text-[length:var(--app-font-size-ui,12px)]">{t("qqbot.sandbox")}</span>
										<span className="mt-0.5 block text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
											{t("qqbot.sandboxHint")}
										</span>
									</span>
									<Switch
										checked={draft.sandbox}
										onCheckedChange={(checked: boolean) => setDraft({ ...draft, sandbox: checked })}
									/>
								</label>
								<label className="flex items-center justify-between gap-3">
									<span className="min-w-0">
										<span className="block text-[length:var(--app-font-size-ui,12px)]">{t("qqbot.markdown")}</span>
										<span className="mt-0.5 block text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
											{t("qqbot.markdownHint")}
										</span>
									</span>
									<Switch
										checked={draft.markdown}
										onCheckedChange={(checked: boolean) => setDraft({ ...draft, markdown: checked })}
									/>
								</label>
							</>
						)}

						<label className="flex items-center justify-between gap-3">
							<span className="min-w-0">
								<span className="block text-[length:var(--app-font-size-ui,12px)]">{t("qqbot.codeImages")}</span>
								<span className="mt-0.5 block text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
									{t("qqbot.codeImagesHint")}
								</span>
							</span>
							<Switch
								checked={draft.codeImages}
								onCheckedChange={(checked: boolean) => setDraft({ ...draft, codeImages: checked })}
							/>
						</label>

						<div className="flex flex-col gap-1">
							<Label>{t("qqbot.project")}</Label>
							<div className="flex items-center gap-2">
								<code className="min-w-0 flex-1 select-text break-all rounded bg-muted px-2 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)]">
									{draft.projectPath || t("qqbot.noProject")}
								</code>
								<Button
									onClick={() => {
										void onChooseProject().then((path) => {
											if (path) setDraft({ ...draft, projectPath: path });
										});
									}}
									size="sm"
									variant="chrome-outline"
								>
									<FolderOpenIcon className="size-3.5" />
									{t("qqbot.chooseProject")}
								</Button>
							</div>
							<p className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
								{t("qqbot.projectHint")}
							</p>
						</div>

					</div>

					<div className="flex shrink-0 items-center justify-end gap-2">
						<Button onClick={onClose} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button disabled={busy || !complete} onClick={() => onSave(draft)} size="sm" variant="subtle">
							{t("common.save")}
						</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
