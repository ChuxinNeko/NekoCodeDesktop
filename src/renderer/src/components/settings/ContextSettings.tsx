import { useEffect, useState } from "react";
import {
	MAX_INSTRUCTIONS_BYTES,
	type InstructionFile,
	type ProjectInstructions,
} from "../../../../shared/instructions";
import { MAX_MEMORY_TEXT, type MemoryEntry, type MemoryScope } from "../../../../shared/memory";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { BookIcon, BrainIcon, PencilIcon, PlusIcon, TrashCanIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SETTINGS_TEXTAREA_CLASS_NAME, SettingsDialog } from "./SettingsDialog";

/** Paths as the renderer can compare them: separators and, on Windows, case do not matter. */
function pathKey(path: string): string {
	const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
}

function baseName(path: string): string {
	const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}

const CARD_CLASS_NAME = "flex flex-col gap-2 rounded-lg border border-[color:var(--app-surface-divider)] px-3 py-2.5";
const CARD_TITLE_CLASS_NAME = "flex items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)] font-medium";
const HINT_CLASS_NAME = "text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground";

interface InstructionDraft {
	scope: "global" | "project";
	path: string;
	content: string;
}

interface MemoryDraft {
	id?: string;
	scope: MemoryScope;
	text: string;
}

/**
 * What the agent is told before the conversation starts: the instruction
 * files it loads, and what it has been asked to remember.
 *
 * Per project, because both are: the same session in another folder loads a
 * different AGENTS.md and a different set of project memories.
 */
export function ContextSettings({ cwd, projects }: { cwd: string | null; projects: readonly string[] }) {
	const { t } = useTranslation();
	const choices = [...new Map([...(cwd ? [cwd] : []), ...projects].map((path) => [pathKey(path), path])).values()];
	const [project, setProject] = useState<string | null>(cwd ?? choices[0] ?? null);
	const [instructions, setInstructions] = useState<ProjectInstructions | null>(null);
	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [editor, setEditor] = useState<InstructionDraft | null>(null);
	const [viewer, setViewer] = useState<InstructionFile | null>(null);
	const [memoryDraft, setMemoryDraft] = useState<MemoryDraft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!project) return;
		setInstructions(null);
		api.instructionsRead(project).then(setInstructions).catch((cause: unknown) => setError(errorMessage(cause)));
	}, [project]);
	useEffect(() => {
		api.memoryList().then((snapshot) => setEntries(snapshot.entries)).catch((cause: unknown) => setError(errorMessage(cause)));
		return api.onMemoryChanged((snapshot) => setEntries(snapshot.entries));
	}, []);

	const run = <T,>(action: Promise<T>, after: (value: T) => void) => {
		setBusy(true);
		setError(null);
		action
			.then(after)
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const loadedFile = (path: string | undefined) =>
		path ? instructions?.loaded.find((file) => pathKey(file.path) === pathKey(path)) : undefined;
	const globalFile = loadedFile(instructions?.globalPath);
	const projectFile = loadedFile(instructions?.projectPath);
	const others = instructions?.loaded.filter((file) => file !== globalFile && file !== projectFile) ?? [];

	const rootKey = instructions ? pathKey(instructions.projectRoot) : null;
	const userMemories = entries.filter((entry) => entry.scope === "user");
	const projectMemories = entries.filter(
		(entry) => entry.scope === "project" && rootKey !== null && entry.project && pathKey(entry.project) === rootKey,
	);
	const elsewhere = entries.filter(
		(entry) => entry.scope === "project" && (rootKey === null || !entry.project || pathKey(entry.project) !== rootKey),
	);

	const openEditor = (scope: "global" | "project") => {
		if (!instructions) return;
		const path = scope === "global" ? instructions.globalPath : instructions.projectPath;
		setEditor({ scope, path, content: loadedFile(path)?.content ?? "" });
	};

	const instructionRow = (label: string, path: string | undefined, file: InstructionFile | undefined, scope: "global" | "project") => (
		<div className="flex items-center gap-2 py-1">
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="text-[length:var(--app-font-size-ui,12px)]">{label}</span>
				<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground" title={path}>
					{path ?? "…"}
				</span>
			</div>
			<span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
				{file
					? t("context.instructions.lines", { count: file.content.split("\n").length })
					: t("context.instructions.missing")}
			</span>
			<Button disabled={!instructions || busy} onClick={() => openEditor(scope)} size="xs" variant="chrome-outline">
				{file ? t("common.edit") : t("context.instructions.create")}
			</Button>
		</div>
	);

	const memoryRow = (entry: MemoryEntry) => (
		<div key={entry.id} className="group flex items-start gap-2 rounded-md px-1 py-1 hover:bg-[var(--sidebar-accent)]">
			<span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed">
				{entry.text}
			</span>
			{entry.source === "agent" ? (
				<span className="mt-0.5 shrink-0 rounded bg-[var(--color-background-elevated-secondary)] px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{t("context.memory.byAgent")}
				</span>
			) : null}
			<Button
				aria-label={t("common.edit")}
				disabled={busy}
				onClick={() => setMemoryDraft({ id: entry.id, scope: entry.scope, text: entry.text })}
				size="icon-xs"
				variant="ghost"
			>
				<PencilIcon className="size-3.5" />
			</Button>
			<Button
				aria-label={t("common.delete")}
				disabled={busy}
				onClick={() => run(api.memoryRemove(entry.id), (snapshot) => setEntries(snapshot.entries))}
				size="icon-xs"
				variant="ghost"
			>
				<TrashCanIcon className="size-3.5" />
			</Button>
		</div>
	);

	const memoryGroup = (title: string, list: MemoryEntry[], empty: string) => (
		<div className="flex flex-col gap-0.5">
			<span className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-muted-foreground">{title}</span>
			{list.length ? list.map(memoryRow) : <span className={cn(HINT_CLASS_NAME, "px-1 py-1")}>{empty}</span>}
		</div>
	);

	const editorBytes = editor ? new TextEncoder().encode(editor.content).length : 0;

	return (
		<section className="flex flex-col gap-3">
			<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("context.intro")}</p>

			{choices.length === 0 ? (
				<p className="rounded-lg border border-dashed border-[color:var(--app-surface-divider)] px-3 py-6 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
					{t("context.noProject")}
				</p>
			) : (
				<div className="flex items-center gap-2">
					<span className="shrink-0 text-[length:var(--app-font-size-ui,12px)]">{t("context.project")}</span>
					<Select value={project} onValueChange={(value) => value && setProject(value)}>
						<SelectTrigger size="sm">
							<SelectValue>{project ? `${baseName(project)} · ${project}` : ""}</SelectValue>
						</SelectTrigger>
						<SelectPopup surface="settings">
							{choices.map((path) => (
								<SelectItem key={path} value={path}>
									{baseName(path)} · {path}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				</div>
			)}

			<div className={CARD_CLASS_NAME}>
				<span className={CARD_TITLE_CLASS_NAME}>
					<BookIcon className="size-3.5" />
					{t("context.instructions.title")}
				</span>
				<p className={HINT_CLASS_NAME}>{t("context.instructions.hint")}</p>
				<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
					{instructionRow(t("context.instructions.global"), instructions?.globalPath, globalFile, "global")}
					{project ? instructionRow(t("context.instructions.project"), instructions?.projectPath, projectFile, "project") : null}
					{others.map((file) => (
						<div key={file.path} className="flex items-center gap-2 py-1">
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="text-[length:var(--app-font-size-ui,12px)]">{t("context.instructions.ancestor")}</span>
								<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground" title={file.path}>
									{file.path}
								</span>
							</div>
							<Button onClick={() => setViewer(file)} size="xs" variant="ghost">
								{t("context.instructions.view")}
							</Button>
						</div>
					))}
				</div>
				<p className={HINT_CLASS_NAME}>{t("context.instructions.initHint")}</p>
			</div>

			<div className={CARD_CLASS_NAME}>
				<div className="flex items-center gap-2">
					<span className={cn(CARD_TITLE_CLASS_NAME, "flex-1")}>
						<BrainIcon className="size-3.5" />
						{t("context.memory.title")}
					</span>
					<Button
						disabled={busy}
						onClick={() => setMemoryDraft({ scope: project ? "project" : "user", text: "" })}
						size="xs"
						variant="chrome-outline"
					>
						<PlusIcon className="size-3.5" />
						{t("context.memory.add")}
					</Button>
				</div>
				<p className={HINT_CLASS_NAME}>{t("context.memory.hint")}</p>
				{memoryGroup(t("context.memory.user"), userMemories, t("context.memory.emptyUser"))}
				{project ? memoryGroup(t("context.memory.project"), projectMemories, t("context.memory.emptyProject")) : null}
				{elsewhere.length ? (
					<details className="text-[length:var(--app-font-size-ui-sm,11px)]">
						<summary className="cursor-default text-muted-foreground">
							{t("context.memory.elsewhere", { count: elsewhere.length })}
						</summary>
						<div className="mt-1 flex flex-col gap-0.5">
							{elsewhere.map((entry) => (
								<div key={entry.id} className="flex flex-col">
									<span className="truncate px-1 font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
										{entry.project}
									</span>
									{memoryRow(entry)}
								</div>
							))}
						</div>
					</details>
				) : null}
			</div>

			{error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null}

			{editor ? (
				<SettingsDialog
					wide
					title={t(editor.scope === "global" ? "context.instructions.editGlobal" : "context.instructions.editProject")}
					description={editor.path}
					onClose={() => setEditor(null)}
					footer={
						<>
							<span
								className={cn(
									"mr-auto text-[length:var(--app-font-size-ui-xs,10px)]",
									editorBytes > MAX_INSTRUCTIONS_BYTES ? "text-destructive" : "text-muted-foreground",
								)}
							>
								{t("context.instructions.size", { kb: (editorBytes / 1024).toFixed(1) })}
							</span>
							<Button onClick={() => setEditor(null)} size="sm" variant="ghost">
								{t("common.cancel")}
							</Button>
							<Button
								disabled={busy || editorBytes > MAX_INSTRUCTIONS_BYTES || !project}
								onClick={() =>
									project &&
									run(api.instructionsSave({ cwd: project, scope: editor.scope, content: editor.content }), (next) => {
										setInstructions(next);
										setEditor(null);
									})
								}
								size="sm"
								variant="subtle"
							>
								{t("common.save")}
							</Button>
						</>
					}
				>
					<textarea
						autoFocus
						className={cn(SETTINGS_TEXTAREA_CLASS_NAME, "min-h-[24rem] flex-1")}
						placeholder={t("context.instructions.placeholder")}
						spellCheck={false}
						value={editor.content}
						onChange={(event) => setEditor({ ...editor, content: event.target.value })}
					/>
					<p className={HINT_CLASS_NAME}>{t("context.instructions.reloadHint")}</p>
				</SettingsDialog>
			) : null}

			{viewer ? (
				<SettingsDialog
					wide
					title={t("context.instructions.ancestor")}
					description={viewer.path}
					onClose={() => setViewer(null)}
					footer={
						<Button onClick={() => setViewer(null)} size="sm" variant="subtle">
							{t("common.close")}
						</Button>
					}
				>
					<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--app-surface-divider)] px-2 py-1.5 font-mono text-[length:var(--app-font-size-ui-sm,11px)]">
						{viewer.content}
					</pre>
				</SettingsDialog>
			) : null}

			{memoryDraft ? (
				<SettingsDialog
					title={t(memoryDraft.id ? "context.memory.editTitle" : "context.memory.addTitle")}
					onClose={() => setMemoryDraft(null)}
					footer={
						<>
							<Button onClick={() => setMemoryDraft(null)} size="sm" variant="ghost">
								{t("common.cancel")}
							</Button>
							<Button
								disabled={busy || !memoryDraft.text.trim() || (memoryDraft.scope === "project" && !project && !memoryDraft.id)}
								onClick={() =>
									run(
										api.memorySave({
											id: memoryDraft.id,
											scope: memoryDraft.scope,
											// An edit keeps the project it was saved for; a new one goes to the one on screen.
											cwd: memoryDraft.id ? undefined : (project ?? undefined),
											text: memoryDraft.text,
										}),
										(snapshot) => {
											setEntries(snapshot.entries);
											setMemoryDraft(null);
										},
									)
								}
								size="sm"
								variant="subtle"
							>
								{t("common.save")}
							</Button>
						</>
					}
				>
					{memoryDraft.id ? null : (
						<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
							{(["project", "user"] as const).map((scope) => (
								<button
									key={scope}
									type="button"
									disabled={scope === "project" && !project}
									onClick={() => setMemoryDraft({ ...memoryDraft, scope })}
									className={cn(
										"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors disabled:opacity-50",
										memoryDraft.scope === scope
											? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{t(scope === "project" ? "context.memory.project" : "context.memory.user")}
								</button>
							))}
						</div>
					)}
					<textarea
						autoFocus
						className={cn(SETTINGS_TEXTAREA_CLASS_NAME, "min-h-28 font-sans")}
						maxLength={MAX_MEMORY_TEXT}
						placeholder={t(memoryDraft.scope === "project" ? "context.memory.placeholderProject" : "context.memory.placeholderUser")}
						value={memoryDraft.text}
						onChange={(event) => setMemoryDraft({ ...memoryDraft, text: event.target.value })}
					/>
					<p className={HINT_CLASS_NAME}>
						{memoryDraft.scope === "project" && instructions && !memoryDraft.id
							? t("context.memory.projectHint", { path: instructions.projectRoot })
							: t("context.memory.userHint")}
					</p>
				</SettingsDialog>
			) : null}
		</section>
	);
}
