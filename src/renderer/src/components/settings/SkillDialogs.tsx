import { useEffect, useState } from "react";
import {
	splitSkillMarkdown,
	validateSkillDraft,
	type CreateSkillRequest,
	type ImportSkillsResult,
	type SkillImportScan,
	type SkillScope,
	type SkillsSnapshot,
} from "../../../../shared/skills";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { SETTINGS_TEXTAREA_CLASS_NAME, SettingsDialog } from "./SettingsDialog";

const HINT_CLASS_NAME = "text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground";

const BODY_PLACEHOLDER = "# …\n\n1. …\n2. …\n";

/** User or project: the two directories a skill written here can go to. */
function ScopePicker({
	value,
	hasProject,
	onChange,
}: {
	value: SkillScope;
	hasProject: boolean;
	onChange: (scope: SkillScope) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col gap-1">
			<Label>{t("skills.field.scope")}</Label>
			<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
				{(["user", "project"] as const).map((scope) => (
					<button
						key={scope}
						type="button"
						disabled={scope === "project" && !hasProject}
						onClick={() => onChange(scope)}
						className={cn(
							"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
							value === scope
								? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{t(scope === "user" ? "skills.scope.user" : "skills.scope.project")}
					</button>
				))}
			</div>
			<span className={HINT_CLASS_NAME}>
				{t(hasProject ? "skills.scope.projectHint" : "skills.scope.noProject")}
			</span>
		</div>
	);
}

/** Write a skill by hand: the three fields a SKILL.md is made of. */
export function NewSkillDialog({
	hasProject,
	onClose,
	onSaved,
}: {
	hasProject: boolean;
	onClose: () => void;
	onSaved: (snapshot: SkillsSnapshot | null) => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<CreateSkillRequest>({ scope: "user", name: "", description: "", body: "" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const problem = validateSkillDraft(draft);

	const save = () => {
		setBusy(true);
		setError(null);
		api
			.skillsCreate(draft)
			.then(onSaved)
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	return (
		<SettingsDialog
			wide
			title={t("skills.createTitle")}
			onClose={onClose}
			footer={
				<>
					{error || problem ? (
						<span
							className={cn(
								"mr-auto text-[length:var(--app-font-size-ui-xs,10px)]",
								error ? "text-destructive" : "text-muted-foreground",
							)}
						>
							{error ?? t(`skills.problem.${problem}` as TranslationKey)}
						</span>
					) : null}
					<Button onClick={onClose} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button disabled={busy || problem !== null} onClick={save} size="sm" variant="subtle">
						{t("common.save")}
					</Button>
				</>
			}
		>
			<ScopePicker
				value={draft.scope}
				hasProject={hasProject}
				onChange={(scope) => setDraft({ ...draft, scope })}
			/>

			<div className="flex flex-col gap-1">
				<Label>{t("skills.field.name")}</Label>
				<Input
					className="font-mono"
					placeholder="my-skill"
					spellCheck={false}
					value={draft.name}
					onChange={(event) => setDraft({ ...draft, name: event.target.value })}
				/>
				<span className={HINT_CLASS_NAME}>{t("skills.field.nameHint")}</span>
			</div>

			<div className="flex flex-col gap-1">
				<Label>{t("skills.field.description")}</Label>
				<Input
					value={draft.description}
					onChange={(event) => setDraft({ ...draft, description: event.target.value })}
				/>
				<span className={HINT_CLASS_NAME}>{t("skills.field.descriptionHint")}</span>
			</div>

			<div className="flex flex-col gap-1">
				<Label>{t("skills.field.body")}</Label>
				<textarea
					className={cn(SETTINGS_TEXTAREA_CLASS_NAME, "min-h-64")}
					placeholder={BODY_PLACEHOLDER}
					spellCheck={false}
					value={draft.body}
					onChange={(event) => setDraft({ ...draft, body: event.target.value })}
					onPaste={(event) => {
						// A whole SKILL.md pasted into an empty editor fills every
						// field, instead of leaving its frontmatter in the body.
						if (draft.body.trim()) return;
						const parsed = splitSkillMarkdown(event.clipboardData.getData("text/plain"));
						if (!parsed) return;
						event.preventDefault();
						setDraft({
							...draft,
							name: parsed.name || draft.name,
							description: parsed.description || draft.description,
							body: parsed.body,
						});
					}}
				/>
				<span className={HINT_CLASS_NAME}>{t("skills.field.bodyHint")}</span>
			</div>
		</SettingsDialog>
	);
}

/**
 * Bring in skills from a folder that is not one the loader reads: show what the
 * folder holds, let the user pick, and copy the picked ones.
 */
export function ImportSkillsDialog({
	source,
	hasProject,
	onChooseOther,
	onClose,
	onImported,
}: {
	source: string;
	hasProject: boolean;
	onChooseOther: () => void;
	onClose: () => void;
	onImported: (result: ImportSkillsResult | null) => void;
}) {
	const { t } = useTranslation();
	const [scope, setScope] = useState<SkillScope>("user");
	const [scan, setScan] = useState<SkillImportScan | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [overwrite, setOverwrite] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setScan(null);
		setError(null);
		api
			.skillsScanImport({ source, scope })
			.then((next) => {
				if (cancelled || !next) return;
				setScan(next);
				// Everything that would import cleanly starts ticked; replacing
				// an installed skill has to be asked for.
				setSelected(
					new Set(next.candidates.filter((entry) => !entry.problem && !entry.exists).map((entry) => entry.dir)),
				);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [source, scope]);

	const candidates = scan?.candidates ?? [];
	const anyExisting = candidates.some((entry) => entry.exists && !entry.problem);
	const selectable = (entry: (typeof candidates)[number]) => !entry.problem && (!entry.exists || overwrite);

	const toggle = (dir: string, checked: boolean) => {
		const next = new Set(selected);
		if (checked) next.add(dir);
		else next.delete(dir);
		setSelected(next);
	};

	const setReplace = (checked: boolean) => {
		setOverwrite(checked);
		if (!checked) {
			// Untick what can no longer be copied, so the count stays honest.
			setSelected(
				new Set(
					[...selected].filter((dir) => !candidates.find((entry) => entry.dir === dir)?.exists),
				),
			);
		}
	};

	const run = () => {
		setBusy(true);
		setError(null);
		api
			.skillsImport({ source, scope, dirs: [...selected], overwrite })
			.then(onImported)
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	return (
		<SettingsDialog
			title={t("skills.importTitle")}
			description={source}
			onClose={onClose}
			footer={
				<>
					<Button className="mr-auto" disabled={busy} onClick={onChooseOther} size="sm" variant="ghost">
						{t("skills.importChooseOther")}
					</Button>
					<Button onClick={onClose} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button disabled={busy || selected.size === 0} onClick={run} size="sm" variant="subtle">
						{t("skills.importAction", { count: selected.size })}
					</Button>
				</>
			}
		>
			<ScopePicker value={scope} hasProject={hasProject} onChange={setScope} />

			<div className="flex flex-col gap-1">
				<span className={HINT_CLASS_NAME}>{t("skills.importHint")}</span>
				<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-border">
					{!scan && !error ? (
						<p className="flex items-center gap-2 px-3 py-4 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							<Spinner className="size-3.5" />
							{t("skills.importScanning")}
						</p>
					) : candidates.length === 0 ? (
						<p className="px-3 py-4 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{t("skills.importEmpty")}
						</p>
					) : (
						candidates.map((entry) => (
							<label
								key={entry.dir}
								className={cn(
									"flex cursor-pointer items-start gap-2.5 px-3 py-2",
									!selectable(entry) && "opacity-60",
								)}
							>
								<Checkbox
									className="mt-0.5"
									checked={selected.has(entry.dir)}
									disabled={!selectable(entry)}
									onCheckedChange={(checked: boolean) => toggle(entry.dir, checked)}
								/>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="flex items-center gap-2">
										<code className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
											{entry.name}
										</code>
										{entry.problem || entry.exists ? (
											<span
												className={cn(
													"shrink-0 rounded-full border px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)]",
													entry.problem
														? "border-[color:var(--warning)]/50 text-[var(--warning)]"
														: "border-border/60 text-muted-foreground",
												)}
											>
												{entry.problem
													? t(`skills.importProblem.${entry.problem}` as TranslationKey)
													: t("skills.importExists")}
											</span>
										) : null}
									</span>
									{entry.description ? (
										<span className="line-clamp-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
											{entry.description}
										</span>
									) : null}
									<span
										className="truncate font-mono text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground/80"
										title={entry.dir}
									>
										{entry.dir}
									</span>
								</span>
							</label>
						))
					)}
				</div>
				{scan?.truncated ? <span className={HINT_CLASS_NAME}>{t("skills.importTruncated")}</span> : null}
			</div>

			{anyExisting ? (
				<label className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]">
					<Checkbox checked={overwrite} onCheckedChange={(checked: boolean) => setReplace(checked)} />
					{t("skills.importOverwrite")}
				</label>
			) : null}

			{error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null}
		</SettingsDialog>
	);
}
