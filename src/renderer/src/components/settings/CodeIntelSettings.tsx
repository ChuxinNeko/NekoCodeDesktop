import { useEffect, useState } from "react";
import type { CodeIntelModelOption, CodeIntelModels, CodeIntelStatus, CodeIntelUpdate, IndexStatus } from "../../../../shared/code-intel";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { CustomizeIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsRow } from "./SettingsRow";

/** Mirrors `CODE_INTEL_CHANGED_EVENT` in the IDE's tab-completion module, which this page must not import. */
const CHANGED_EVENT = "nekocode:code-intel-changed";

const hintClass = "text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground";

/** Choose one model from Providers and models; nothing here configures a model itself. */
function ModelDialog({
	title,
	description,
	hint,
	options,
	current,
	busy,
	error,
	onClose,
	onSave,
}: {
	title: string;
	description: string;
	hint: string;
	options: CodeIntelModelOption[];
	current: string | null;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onSave: (key: string) => void;
}) {
	const { t } = useTranslation();
	// The current pick or nothing — never an arbitrary first entry, which would
	// choose a model for the user on Save.
	const [key, setKey] = useState(current && options.some((option) => option.key === current) ? current : "");
	const selected = options.find((option) => option.key === key);
	return (
		<SettingsDialog
			title={title}
			description={description}
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button disabled={busy || !key} onClick={() => onSave(key)} size="sm" variant="subtle">
						{t("common.save")}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-1">
				<Label>{t("codeIntel.model")}</Label>
				<Select value={key} onValueChange={(next) => setKey(typeof next === "string" ? next : "")}>
					<SelectTrigger size="sm">
						<SelectValue>{selected?.label ?? t("codeIntel.pickModel")}</SelectValue>
					</SelectTrigger>
					<SelectPopup surface="settings">
						{(["custom", "account"] as const).map((group) => {
							const members = options.filter((option) => option.group === group);
							return members.length ? (
								<SelectGroup key={group}>
									<SelectGroupLabel>{t(group === "custom" ? "codeIntel.group.custom" : "codeIntel.group.account")}</SelectGroupLabel>
									{members.map((option) => (
										<SelectItem key={option.key} value={option.key}>
											{option.label}
										</SelectItem>
									))}
								</SelectGroup>
							) : null;
						})}
					</SelectPopup>
				</Select>
				<p className={hintClass}>{hint}</p>
			</div>
			{error ? <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</p> : null}
		</SettingsDialog>
	);
}

function StatusDot({ tone }: { tone: "off" | "ok" | "busy" | "warn" }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"size-2 shrink-0 rounded-full",
				tone === "off" && "bg-muted-foreground/40",
				tone === "ok" && "bg-[var(--success,#16a34a)]",
				tone === "busy" && "animate-pulse bg-[var(--success,#16a34a)]",
				tone === "warn" && "bg-[var(--warning,#d97706)]",
			)}
		/>
	);
}

function indexLine(t: ReturnType<typeof useTranslation>["t"], index: IndexStatus, assisted: boolean): string {
	if (index.state === "idle" && !index.files) return t("codeIntel.index.notStarted");
	const counts = t("codeIntel.index.counts", { files: index.files, chunks: index.chunks });
	if (index.state === "scanning") return `${t("codeIntel.index.scanning")} · ${counts}`;
	return `${counts} · ${t(assisted ? "codeIntel.index.assisted" : "codeIntel.index.lexical")}`;
}

/**
 * One model choice at a glance: what is picked, and why it matters. With no
 * candidates at all the card says what to add under Providers and models, and
 * takes the user there.
 */
function ModelCard({
	title,
	options,
	current,
	emptyHint,
	missingHint,
	unsetHint,
	setHint,
	dimmed,
	onPick,
	onClear,
	onOpenProviders,
}: {
	title: string;
	options: CodeIntelModelOption[] | null;
	current: string | null;
	emptyHint: string;
	missingHint: string;
	unsetHint: string;
	setHint: string;
	dimmed?: boolean;
	onPick: () => void;
	onClear?: () => void;
	onOpenProviders: () => void;
}) {
	const { t } = useTranslation();
	const empty = options !== null && options.length === 0;
	const chosen = current ? options?.find((option) => option.key === current) : undefined;
	// Picked once, then its provider or model was removed.
	const missing = !!current && options !== null && !chosen;
	const tone = empty || missing ? "warn" : chosen ? "ok" : "off";
	return (
		<div className={cn("flex items-center justify-between gap-4", dimmed && "opacity-60")}>
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<StatusDot tone={tone} />
					{title}
					{chosen ? <span className="truncate font-mono text-xs text-muted-foreground">{chosen.label}</span> : null}
				</div>
				<p className={cn("mt-1 text-xs", empty || missing ? "text-[var(--warning,#d97706)]" : "text-muted-foreground")}>
					{empty ? emptyHint : missing ? missingHint : chosen ? setHint : unsetHint}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{chosen && onClear ? (
					<Button onClick={onClear} size="sm" variant="ghost">
						{t("codeIntel.clearModel")}
					</Button>
				) : null}
				{empty ? (
					<Button onClick={onOpenProviders} size="sm" variant="chrome-outline">
						{t("codeIntel.openProviders")}
					</Button>
				) : (
					<Button disabled={options === null} onClick={onPick} size="sm" variant="chrome-outline">
						<CustomizeIcon className="size-3.5" />
						{t("codeIntel.pickModel")}
					</Button>
				)}
			</div>
		</div>
	);
}

/** The code index and Tab completion at a glance; both run on models from Providers and models. */
export function CodeIntelSettings({ cwd, onOpenProviders }: { cwd: string | null; onOpenProviders: () => void }) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<CodeIntelStatus | null>(null);
	const [models, setModels] = useState<CodeIntelModels | null>(null);
	const [index, setIndex] = useState<IndexStatus | null>(null);
	const [editing, setEditing] = useState<"search" | "completion" | "prediction" | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.codeIntelStatus().then(setStatus).catch((cause: unknown) => setError(errorMessage(cause)));
		api.codeIntelModels().then(setModels).catch(() => setModels({ chat: [] }));
	}, []);

	useEffect(() => {
		if (!cwd || !status?.indexEnabled) {
			setIndex(null);
			return;
		}
		let live = true;
		const same = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		api.codeIndexStatus(cwd).then((next) => live && setIndex(next)).catch(() => {});
		const unsubscribe = api.onCodeIndexChanged((next) => {
			if (live && same(next.cwd) === same(cwd)) setIndex(next);
		});
		return () => {
			live = false;
			unsubscribe();
		};
	}, [cwd, status?.indexEnabled]);

	const save = (patch: CodeIntelUpdate) => {
		setBusy(true);
		setError(null);
		api
			.codeIntelSave(patch)
			.then((next) => {
				setStatus(next);
				window.dispatchEvent(new Event(CHANGED_EVENT));
				setEditing(null);
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const rebuild = () => {
		if (!cwd) return;
		setBusy(true);
		api
			.codeIndexRebuild(cwd)
			.then(setIndex)
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const completion = status?.completion;
	// Keywords alone until a model is picked and still under Providers and models.
	const assisted = !!status?.searchModel && !!models?.chat.some((option) => option.key === status.searchModel);
	const indexTone = !status?.indexEnabled
		? "off"
		: index?.state === "error"
			? "warn"
			: index?.state === "scanning"
				? "busy"
				: "ok";
	const closeDialog = () => {
		setEditing(null);
		setError(null);
	};

	return (
		<section className="flex flex-col gap-4 text-[length:var(--app-font-size-ui,12px)]">
			<p className="leading-relaxed text-muted-foreground">{t("codeIntel.intro")}</p>

			<h3 className="font-medium">{t("codeIntel.index.title")}</h3>
			<div className="divide-y divide-[color:var(--app-surface-divider)]">
				<SettingsRow label={t("codeIntel.index.enabled")} hint={t("codeIntel.index.enabledHint")}>
					<Switch
						checked={status?.indexEnabled ?? false}
						disabled={!status || busy}
						onCheckedChange={(checked: boolean) => save({ indexEnabled: checked })}
					/>
				</SettingsRow>
			</div>

			<div className={cn("flex flex-col gap-3 rounded-xl border border-[color:var(--app-surface-divider)] p-4", status && !status.indexEnabled && "opacity-60")}>
				<div className="flex items-center justify-between gap-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<StatusDot tone={indexTone} />
							{t("codeIntel.index.project")}
							{cwd ? <span className="truncate font-mono text-xs text-muted-foreground">{cwd}</span> : null}
						</div>
						<p className={cn("mt-1 text-xs", index?.error ? "text-[var(--warning,#d97706)]" : "text-muted-foreground")}>
							{!cwd
								? t("codeIntel.index.noProject")
								: index
									? (index.error ?? indexLine(t, index, assisted))
									: status?.indexEnabled
										? t("codeIntel.index.notStarted")
										: t("codeIntel.index.off")}
						</p>
					</div>
					<Button disabled={!cwd || !status?.indexEnabled || busy} onClick={rebuild} size="sm" variant="chrome-outline">
						{t("codeIntel.index.rebuild")}
					</Button>
				</div>
				<div className="border-t border-[color:var(--app-surface-divider)] pt-3">
					<ModelCard
						title={t("codeIntel.search.title")}
						options={models?.chat ?? null}
						current={status?.searchModel ?? null}
						emptyHint={t("codeIntel.noModels")}
						missingHint={t("codeIntel.missingModel")}
						unsetHint={t("codeIntel.search.offHint")}
						setHint={t("codeIntel.search.onHint")}
						onPick={() => setEditing("search")}
						onClear={() => save({ searchModel: null })}
						onOpenProviders={onOpenProviders}
					/>
				</div>
			</div>

			<h3 className="font-medium">{t("codeIntel.completion.title")}</h3>
			<div className="divide-y divide-[color:var(--app-surface-divider)]">
				<SettingsRow label={t("codeIntel.completion.enabled")} hint={t("codeIntel.completion.enabledHint")}>
					<Switch
						checked={completion?.enabled ?? false}
						disabled={!status || busy}
						onCheckedChange={(checked: boolean) => save({ completion: { enabled: checked } })}
					/>
				</SettingsRow>
			</div>
			<div className="rounded-xl border border-[color:var(--app-surface-divider)] p-4">
				<ModelCard
					title={t("codeIntel.completion.model")}
					options={models?.chat ?? null}
					current={completion?.modelKey ?? null}
					emptyHint={t("codeIntel.noModels")}
					missingHint={t("codeIntel.missingModel")}
					unsetHint={t(completion?.enabled ? "codeIntel.completion.missing" : "codeIntel.completion.unset")}
					setHint={t("codeIntel.completion.usage")}
					dimmed={!!completion && !completion.enabled}
					onPick={() => setEditing("completion")}
					onOpenProviders={onOpenProviders}
				/>
			</div>

			<h3 className="font-medium">{t("codeIntel.prediction.title")}</h3>
			<div className="divide-y divide-[color:var(--app-surface-divider)]">
				<SettingsRow label={t("codeIntel.prediction.enabled")} hint={t("codeIntel.prediction.enabledHint")}>
					<Switch
						aria-label={t("codeIntel.prediction.enabled")}
						checked={status?.prediction?.enabled ?? false}
						disabled={!status || busy}
						onCheckedChange={(checked: boolean) => save({ prediction: { enabled: checked } })}
					/>
				</SettingsRow>
			</div>
			<div className="rounded-xl border border-[color:var(--app-surface-divider)] p-4">
				<ModelCard
					title={t("codeIntel.prediction.model")}
					options={models?.chat ?? null}
					current={status?.prediction?.modelKey ?? null}
					emptyHint={t("codeIntel.noModels")}
					missingHint={t("codeIntel.missingModel")}
					unsetHint={t(status?.prediction?.enabled ? "codeIntel.prediction.missing" : "codeIntel.prediction.unset")}
					setHint={t("codeIntel.prediction.usage")}
					dimmed={!!status?.prediction && !status.prediction.enabled}
					onPick={() => setEditing("prediction")}
					onOpenProviders={onOpenProviders}
				/>
			</div>

			{error && !editing ? (
				<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">
					{error}
				</p>
			) : null}

			{editing === "search" && status && models ? (
				<ModelDialog
					title={t("codeIntel.search.dialogTitle")}
					description={t("codeIntel.search.dialogDescription")}
					hint={t("codeIntel.search.pickHint")}
					options={models.chat}
					current={status.searchModel}
					busy={busy}
					error={error}
					onClose={closeDialog}
					onSave={(key) => save({ searchModel: key })}
				/>
			) : null}
			{editing === "completion" && status && models ? (
				<ModelDialog
					title={t("codeIntel.completion.dialogTitle")}
					description={t("codeIntel.completion.dialogDescription")}
					hint={t("codeIntel.completion.pickHint")}
					options={models.chat}
					current={status.completion.modelKey}
					busy={busy}
					error={error}
					onClose={closeDialog}
					onSave={(key) => save({ completion: { modelKey: key, enabled: true } })}
				/>
			) : null}
			{editing === "prediction" && status && models ? (
				<ModelDialog
					title={t("codeIntel.prediction.dialogTitle")}
					description={t("codeIntel.prediction.dialogDescription")}
					hint={t("codeIntel.prediction.pickHint")}
					options={models.chat}
					current={status.prediction.modelKey}
					busy={busy}
					error={error}
					onClose={closeDialog}
					onSave={(key) => save({ prediction: { modelKey: key, enabled: true } })}
				/>
			) : null}
		</section>
	);
}
