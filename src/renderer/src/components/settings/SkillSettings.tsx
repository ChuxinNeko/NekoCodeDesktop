import { useCallback, useEffect, useState } from "react";
import type { ImportSkillsResult, SkillOrigin, SkillSummary, SkillsSnapshot } from "../../../../shared/skills";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { FolderIcon, PlusIcon, TrashCanIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { useHostDirectoryPicker } from "../HostDirectoryPicker";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { ImportSkillsDialog, NewSkillDialog } from "./SkillDialogs";

/**
 * Which skills the agent knows about, and which of the shipped ones are on.
 *
 * A skill costs a name and a one-line description in every system prompt, and
 * buys a procedure the model can read when the task matches. That trade is the
 * whole reason this page exists: switching one off is how you take the line back
 * when you never use it. The user's own skills can be written or imported here
 * too; they land as folders in the directories the loader already reads.
 */

const ORIGIN_LABELS: Record<SkillOrigin, TranslationKey> = {
	builtin: "skills.origin.builtin",
	user: "skills.origin.user",
	project: "skills.origin.project",
	package: "skills.origin.package",
};

function OriginTag({ origin }: { origin: SkillOrigin }) {
	const { t } = useTranslation();
	return (
		<span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
			{t(ORIGIN_LABELS[origin])}
		</span>
	);
}

/** Name, description and path — the three things that identify a skill. */
function SkillRow({
	skill,
	action,
	dimmed,
}: {
	skill: SkillSummary;
	action?: React.ReactNode;
	dimmed?: boolean;
}) {
	return (
		<div className={cn("flex items-start gap-3 px-3 py-2.5", dimmed && "opacity-60")}>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<code className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
						{skill.name}
					</code>
					<OriginTag origin={skill.origin} />
				</div>
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{skill.description}
				</span>
				<span
					className="truncate font-mono text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground/80"
					title={skill.path}
				>
					{skill.path}
				</span>
			</div>
			{action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
		</div>
	);
}

function Card({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-border">
			{children}
		</div>
	);
}

function Note({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
			{children}
		</p>
	);
}

/** Paths as the loader and a directory listing may each spell them. */
function pathKey(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

export function SkillSettings() {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	/** The built-in skill being switched, or the path of the skill being deleted. */
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** The last import's outcome, until the next action replaces it. */
	const [notice, setNotice] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [importSource, setImportSource] = useState<string | null>(null);
	const [removing, setRemoving] = useState<SkillSummary | null>(null);
	const pickDirectory = useHostDirectoryPicker();

	const load = useCallback(() => {
		api
			.skillsList()
			.then((value) => setSnapshot(value))
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		load();
		// Opening a project is what makes project skills discoverable, and it
		// arrives as a snapshot rather than as an event of its own.
		return api.onAgentSnapshot(() => load());
	}, [load]);

	const toggle = (skill: SkillSummary, enabled: boolean) => {
		setPending(skill.name);
		setError(null);
		// Paint the switch immediately: reloading the session's resources takes a
		// moment, and a switch that lags behind the finger reads as broken.
		setSnapshot((current) =>
			current
				? {
						...current,
						builtin: current.builtin.map((entry) =>
							entry.name === skill.name ? { ...entry, enabled } : entry,
						),
					}
				: current,
		);
		api
			.skillsSetEnabled({ name: skill.name, enabled })
			.then((value) => {
				if (value) setSnapshot(value);
			})
			.catch((cause: unknown) => {
				setError(errorMessage(cause));
				load();
			})
			.finally(() => setPending(null));
	};

	const chooseImportSource = async () => {
		setError(null);
		setNotice(null);
		const path = await pickDirectory(importSource ?? api.homeDir);
		if (path) setImportSource(path);
	};

	const imported = (result: ImportSkillsResult | null) => {
		setImportSource(null);
		if (!result) return;
		setSnapshot(result.snapshot);
		const lines = [
			...(result.imported.length ? [t("skills.importDone", { count: result.imported.length })] : []),
			...result.skipped.map((entry) =>
				t("skills.importSkipped", {
					name: entry.name,
					reason: entry.message ?? t(`skills.importProblem.${entry.reason}` as TranslationKey),
				}),
			),
		];
		setNotice(lines.length ? lines.join("\n") : null);
	};

	const remove = (skill: SkillSummary) => {
		setPending(skill.path);
		setError(null);
		setNotice(null);
		api
			.skillsRemove({ path: skill.path })
			.then((value) => {
				if (value) setSnapshot(value);
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => {
				setPending(null);
				setRemoving(null);
			});
	};

	if (loading) {
		return (
			<section className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				<Spinner className="size-3.5" />
				{t("skills.loading")}
			</section>
		);
	}

	const hasProject = !!snapshot?.directories.project;

	return (
		<>
			<SkillSettingsView
				snapshot={snapshot}
				pending={pending}
				error={error}
				notice={notice}
				onToggle={toggle}
				onCreate={() => {
					setNotice(null);
					setCreating(true);
				}}
				onImport={() => void chooseImportSource()}
				onRemove={setRemoving}
			/>

			{creating ? (
				<NewSkillDialog
					hasProject={hasProject}
					onClose={() => setCreating(false)}
					onSaved={(value) => {
						if (value) setSnapshot(value);
						setCreating(false);
					}}
				/>
			) : null}

			{importSource ? (
				<ImportSkillsDialog
					key={importSource}
					source={importSource}
					hasProject={hasProject}
					onChooseOther={() => void chooseImportSource()}
					onClose={() => setImportSource(null)}
					onImported={imported}
				/>
			) : null}

			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open && !pending) setRemoving(null);
				}}
				title={t("skills.removeTitle", { name: removing?.name ?? "" })}
				description={t("skills.removeDescription")}
				footer={
					<>
						<Button disabled={!!pending} onClick={() => setRemoving(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button
							disabled={!!pending}
							onClick={() => removing && remove(removing)}
							size="sm"
							variant="destructive"
						>
							{t("common.delete")}
						</Button>
					</>
				}
			>
				<code className="break-all font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{removing?.path.replace(/[\\/]SKILL\.md$/, "")}
				</code>
			</ConfirmDialog>
		</>
	);
}

/**
 * The page itself, once there is something to show. Kept apart from the fetching
 * so the layout can be rendered from a fixture.
 */
export function SkillSettingsView({
	snapshot,
	pending,
	error,
	notice,
	onToggle,
	onCreate,
	onImport,
	onRemove,
}: {
	snapshot: SkillsSnapshot | null;
	/** The built-in skill being switched, or the path of the skill being deleted. */
	pending?: string | null;
	error?: string | null;
	notice?: string | null;
	onToggle: (skill: SkillSummary, enabled: boolean) => void;
	onCreate?: () => void;
	onImport?: () => void;
	onRemove?: (skill: SkillSummary) => void;
}) {
	const { t } = useTranslation();
	const builtin = snapshot?.builtin ?? [];
	const installed = snapshot?.installed ?? [];
	const installedPaths = new Set(installed.map((skill) => pathKey(skill.path)));
	// Everything the session loaded that this page does not already list above.
	const discovered = (snapshot?.active ?? []).filter(
		(skill) => skill.origin !== "builtin" && !installedPaths.has(pathKey(skill.path)),
	);

	return (
		<section className="flex flex-col gap-4">
			<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{t("skills.intro")}
			</p>

			{onCreate || onImport ? (
				<div className="flex flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-2">
						{onCreate ? (
							<Button onClick={onCreate} size="sm" variant="chrome-outline">
								<PlusIcon className="size-3.5" />
								{t("skills.create")}
							</Button>
						) : null}
						{onImport ? (
							<Button onClick={onImport} size="sm" variant="chrome-outline">
								<FolderIcon className="size-3.5" />
								{t("skills.import")}
							</Button>
						) : null}
					</div>
					{notice ? (
						<span className="whitespace-pre-line text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{notice}
						</span>
					) : null}
				</div>
			) : null}

			<div className="flex flex-col gap-2">
				<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
					{t("skills.builtinTitle")}
				</h3>
				<Card>
					{builtin.length === 0 ? (
						<Note>{t("skills.builtinMissing")}</Note>
					) : (
						builtin.map((skill) => (
							<SkillRow
								key={skill.name}
								skill={skill}
								dimmed={!skill.enabled}
								action={
									<Switch
										checked={skill.enabled}
										disabled={pending === skill.name}
										onCheckedChange={(checked: boolean) => onToggle(skill, checked)}
									/>
								}
							/>
						))
					)}
				</Card>
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{t("skills.builtinHint")}
				</span>
			</div>

			<div className="flex flex-col gap-2">
				<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
					{t("skills.mineTitle")}
				</h3>
				<Card>
					{installed.length === 0 ? (
						<Note>{t("skills.mineEmpty")}</Note>
					) : (
						installed.map((skill) => (
							<SkillRow
								key={skill.path}
								skill={skill}
								action={
									onRemove ? (
										<Button
											aria-label={t("common.delete")}
											title={t("common.delete")}
											disabled={pending === skill.path}
											onClick={() => onRemove(skill)}
											size="icon-xs"
											variant="ghost"
										>
											<TrashCanIcon className="size-3.5" />
										</Button>
									) : undefined
								}
							/>
						))
					)}
				</Card>
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{t("skills.mineHint")}
				</span>
				<div className="flex flex-col gap-0.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					<span className="truncate" title={snapshot?.directories.user}>
						{snapshot?.directories.user ?? "—"}
					</span>
					<span className="truncate" title={snapshot?.directories.project ?? undefined}>
						{snapshot?.directories.project ?? t("skills.noProject")}
					</span>
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
					{t("skills.discoveredTitle")}
				</h3>
				<Card>
					{!snapshot || snapshot.active.length === 0 ? (
						<Note>{t("skills.needSession")}</Note>
					) : discovered.length === 0 ? (
						<Note>{t("skills.discoveredEmpty")}</Note>
					) : (
						discovered.map((skill) => <SkillRow key={skill.path} skill={skill} />)
					)}
				</Card>
			</div>

			{snapshot && snapshot.warnings.length > 0 ? (
				<div className="flex flex-col gap-1">
					<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
						{t("skills.warningsTitle")}
					</h3>
					{snapshot.warnings.map((warning) => (
						<span
							key={warning}
							className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]"
						>
							{warning}
						</span>
					))}
				</div>
			) : null}

			{error ? (
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span>
			) : null}
		</section>
	);
}
