import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import type { ThinkingLevel } from "../../../../shared/agent";
import {
	defaultThinkingLevels,
	effectiveThinkingLevels,
	effectiveModelLimits,
	MAX_CONTEXT_WINDOW,
	MAX_OUTPUT_TOKENS,
	MIN_TOKEN_LIMIT,
	THINKING_LEVEL_ORDER,
	type FetchedModel,
	type ModelProfileSummary,
	type ModelTokenLimits,
	type OAuthProviderSummary,
} from "../../../../shared/settings";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { CheckIcon, PlusIcon, RefreshCwIcon, XIcon } from "../../lib/icons";
import { OAuthUsage } from "./OAuthUsage";
import type { ModelSettingsChange } from "../../lib/modelSettings";
export type { ModelSettingsChange } from "../../lib/modelSettings";

/** Below this many entries the list is short enough to scan without a filter. */
const SEARCH_THRESHOLD = 8;

/**
 * Picks which of a provider's models this app may use.
 *
 * Every add/remove writes straight through to the provider — there is no second
 * save step, because a half-applied model list is not a state worth having.
 */
/**
 * One fetched model. An already-enabled row is text only: there is nothing to
 * tick, and offering a box that does nothing is worse than offering none.
 */
function FetchedRow({
	added,
	checked,
	disabled,
	id,
	name,
	onToggle,
}: {
	added: boolean;
	checked: boolean;
	disabled: boolean;
	id: string;
	name: string;
	onToggle: () => void;
}) {
	const body = (
		<span className="flex min-w-0 flex-1 flex-col">
			<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)]">{id}</span>
			{name !== id ? (
				<span className="truncate text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
					{name}
				</span>
			) : null}
		</span>
	);
	if (added) return body;
	// A label, so the whole row is the hit target — picking twenty models by
	// aiming at twenty 16px boxes is the thing this is meant to replace.
	return (
		<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
			<Checkbox aria-label={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} />
			{body}
		</label>
	);
}

/**
 * One toggle per thinking level, in order. The last checked level cannot be
 * unchecked: a model offers at least one, even if that one is "off".
 */
function ThinkingLevelPicker({
	value,
	onChange,
}: {
	value: readonly ThinkingLevel[];
	onChange: (levels: ThinkingLevel[]) => void;
}) {
	return (
		<div className="flex flex-wrap gap-1" role="group">
			{THINKING_LEVEL_ORDER.map((level) => {
				const on = value.includes(level);
				return (
					<button
						key={level}
						type="button"
						aria-pressed={on}
						disabled={on && value.length === 1}
						onClick={() =>
							onChange(
								on
									? value.filter((entry) => entry !== level)
									: THINKING_LEVEL_ORDER.filter((entry) => entry === level || value.includes(entry)),
							)
						}
						className={cn(
							"rounded-md border px-2 py-0.5 font-mono text-[length:var(--app-font-size-ui-2xs,9px)] transition-colors disabled:cursor-not-allowed",
							on
								? "border-[color:var(--color-border-focus)] bg-[var(--color-background-elevated-secondary)] text-foreground"
								: "border-border text-muted-foreground hover:text-foreground",
						)}
					>
						{level}
					</button>
				);
			})}
		</div>
	);
}

function sameLevels(a: readonly ThinkingLevel[], b: readonly ThinkingLevel[]): boolean {
	return a.length === b.length && a.every((level, index) => level === b[index]);
}

function CapabilitySources({ profile, modelId }: { profile: ModelProfileSummary; modelId: string }) {
	const { t } = useTranslation();
	const detected = profile.modelCapabilities?.[modelId];
	const source = (key: "contextWindow" | "maxTokens" | "thinkingLevels") => {
		const manual = key === "thinkingLevels" ? profile.modelThinking?.[modelId] : profile.modelOverrides?.[modelId];
		return t(manual ? "models.sourceManual" : detected?.sources[key] === "endpoint" ? "models.sourceEndpoint"
			: detected?.sources[key] === "catalog" ? "models.sourceCatalog" : "models.sourceDefault");
	};
	return <span className="text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground"
		title={detected ? t("models.capabilitiesUpdated", { time: new Date(detected.fetchedAt).toLocaleString() }) : undefined}>
		{t("models.capabilitySources", { context: source("contextWindow"), output: source("maxTokens"), thinking: source("thinkingLevels") })}
	</span>;
}

/** A token limit the backend would accept — blank is not one, the field is required. */
function parseLimit(raw: string, max: number): number | null {
	const value = Number(raw.trim());
	return Number.isInteger(value) && value >= MIN_TOKEN_LIMIT && value <= max ? value : null;
}

export function ModelsTab({
	profiles,
	accounts,
	selectedId,
	busy,
	autoFetchId,
	onSelect,
	onAutoFetchHandled,
	onFetch,
	onSaveModels,
	onSaveModelSettings,
	onTest,
	onAddProvider,
}: {
	profiles: ModelProfileSummary[];
	/** Signed-in OAuth accounts with imported models — each is its own read-only provider category. */
	accounts: OAuthProviderSummary[];
	selectedId: string | null;
	busy: boolean;
	/** A provider that was just created: pull its list without being asked. */
	autoFetchId: string | null;
	onSelect: (id: string) => void;
	onAutoFetchHandled: () => void;
	onFetch: (profile: ModelProfileSummary) => Promise<FetchedModel[] | null>;
	onSaveModels: (profile: ModelProfileSummary, modelIds: string[]) => void;
	/**
	 * A model's own settings. For each half, `undefined` leaves it as stored and
	 * `null` clears it, so the model follows the provider again.
	 */
	onSaveModelSettings: (profile: ModelProfileSummary, modelIds: string[], settings: ModelSettingsChange) => void;
	onTest: (profileId: string, modelId: string) => void;
	onAddProvider: () => void;
}) {
	const { t } = useTranslation();
	// Keyed by provider so switching back and forth does not re-hit the network.
	const [fetched, setFetched] = useState<Record<string, FetchedModel[]>>({});
	const [query, setQuery] = useState("");
	const [manual, setManual] = useState("");
	/** Ids ticked in the fetched list, waiting to be added in one go. */
	const [picked, setPicked] = useState<Set<string>>(new Set());
	/** The model whose settings dialog is open, if any. */
	const [limitsEditor, setLimitsEditor] = useState<string | null>(null);
	/** The model a removal confirmation is open for; the row's X only opens it. */
	const [removing, setRemoving] = useState<string | null>(null);
	const [batchPicked, setBatchPicked] = useState<Set<string>>(new Set());
	const [batchEditor, setBatchEditor] = useState<string[] | null>(null);

	const load = async (target: ModelProfileSummary) => {
		const result = await onFetch(target);
		if (result) setFetched((prev) => ({ ...prev, [target.id]: result }));
		setPicked(new Set());
	};

	// The selection names either a custom profile or an OAuth account; a
	// profile wins on an id collision so existing saved selections keep working.
	const oauthAccounts = accounts.filter(
		(account) => account.signedIn && account.modelIds.length > 0,
	);
	const profile = profiles.find((entry) => entry.id === selectedId) ?? null;
	const oauthAccount = profile
		? null
		: (oauthAccounts.find((entry) => entry.id === selectedId) ?? null);

	// Clearing the request first is what keeps this to one fetch: the effect
	// re-runs on the cleared id and falls straight out.
	const profileId = profile?.id ?? null;
	useEffect(() => {
		if (!profile || autoFetchId !== profile.id) return;
		onAutoFetchHandled();
		void load(profile);
	}, [autoFetchId, profileId]);

	useEffect(() => {
		setPicked(new Set());
		setBatchPicked(new Set());
		setBatchEditor(null);
	}, [profileId]);

	// An OAuth subscription's model list is the provider's to decide, so those
	// categories render read-only below — add/remove/fetch are profile-only tools.
	if (profiles.length === 0 && oauthAccounts.length === 0) {
		return (
			<div className="flex flex-col gap-3">
				<div className="flex flex-col items-start gap-3 rounded-xl border border-border px-3 py-4">
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("models.noProviders")}
					</p>
					<Button onClick={onAddProvider} size="sm" variant="subtle">
						<PlusIcon className="size-3.5" />
						{t("providers.add")}
					</Button>
				</div>
			</div>
		);
	}

	const enabled = profile?.modelIds ?? [];
	const batchSelection = enabled.filter((id) => batchPicked.has(id));
	const batchAllSelected = enabled.length > 0 && batchSelection.length === enabled.length;
	const toggleBatch = (modelId: string) => setBatchPicked((previous) => {
		const next = new Set(previous);
		if (!next.delete(modelId)) next.add(modelId);
		return next;
	});
	const available = profile ? (fetched[profile.id] ?? null) : null;
	const needle = query.trim().toLowerCase();
	const filtered = (available ?? []).filter(
		(model) =>
			!needle ||
			model.id.toLowerCase().includes(needle) ||
			model.name.toLowerCase().includes(needle),
	);

	const add = (modelId: string) => {
		const id = modelId.trim();
		if (!profile || !id || enabled.includes(id)) return;
		onSaveModels(profile, [...enabled, id]);
	};

	// Only rows that are not already enabled can be ticked; the rest have nothing
	// to add and would make a count the action cannot honour.
	//
	// Two scopes on purpose. Ticks survive the search box — narrowing the list is
	// how you find the next model to tick, not a reason to drop the ones already
	// chosen — so the action spans everything fetched. "Select all" is the one
	// thing that means the visible rows, because that is what "all" looks like
	// from where the user is standing.
	const selected = (available ?? []).filter(
		(model) => picked.has(model.id) && !enabled.includes(model.id),
	);
	const selectable = filtered.filter((model) => !enabled.includes(model.id));
	const allSelected = selectable.length > 0 && selectable.every((model) => picked.has(model.id));

	const togglePick = (modelId: string) => {
		setPicked((previous) => {
			const next = new Set(previous);
			if (!next.delete(modelId)) next.add(modelId);
			return next;
		});
	};

	// Scoped to the current search, because that is the list in front of the
	// user — "all" meaning the hidden rows too is a nasty surprise.
	const toggleAll = () => {
		setPicked((previous) => {
			const next = new Set(previous);
			for (const model of selectable) {
				if (allSelected) next.delete(model.id);
				else next.add(model.id);
			}
			return next;
		});
	};

	/** One save for the whole selection rather than a round trip per model. */
	const addPicked = () => {
		if (!profile || selected.length === 0) return;
		onSaveModels(profile, [...enabled, ...selected.map((model) => model.id)]);
		setPicked(new Set());
	};

	const effectiveLimits = (modelId: string): ModelTokenLimits =>
		profile ? effectiveModelLimits(profile, modelId) : { contextWindow: 0, maxTokens: 0 };

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1.5">
				<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("models.provider")}
				</span>
				<div className="flex flex-wrap items-center gap-1">
					{profiles.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => {
								onSelect(entry.id);
								setQuery("");
								setLimitsEditor(null);
							}}
							className={cn(
								"flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								profile?.id === entry.id
									? "border-transparent bg-[var(--color-background-button-secondary)] text-foreground"
									: "border-border text-muted-foreground hover:text-foreground",
							)}
						>
							<span className="max-w-40 truncate">{entry.name}</span>
							<span className="text-[length:var(--app-font-size-ui-2xs,9px)] opacity-60">
								{entry.modelIds.length}
							</span>
						</button>
					))}
					{oauthAccounts.map((account) => (
						<button
							key={`oauth-${account.id}`}
							type="button"
							onClick={() => {
								onSelect(account.id);
								setQuery("");
								setLimitsEditor(null);
							}}
							className={cn(
								"flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								oauthAccount?.id === account.id
									? "border-transparent bg-[var(--color-background-button-secondary)] text-foreground"
									: "border-border text-muted-foreground hover:text-foreground",
							)}
						>
							<span className="max-w-40 truncate">{`${account.name} OAuth`}</span>
							<span className="text-[length:var(--app-font-size-ui-2xs,9px)] opacity-60">
								{account.modelIds.length}
							</span>
						</button>
					))}
				</div>
			</div>

			{oauthAccount ? (
				<div className="flex flex-col gap-2 rounded-xl border border-border p-3">
					{oauthAccount.id === "antigravity" && oauthAccount.signedIn ? <OAuthUsage provider={oauthAccount.id} /> : null}
					<div className="flex items-center gap-2">
						<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
							{t("models.enabled")}
						</span>
						<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{oauthAccount.modelIds.length}
						</span>
					</div>

					<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
						{oauthAccount.modelIds.map((modelId) => {
							const model = oauthAccount.models?.find((entry) => entry.id === modelId);
							return (
								<div key={modelId} className="flex items-center gap-2 py-1">
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
											{modelId}
										</span>
										{model ? (
											<span className="truncate text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
												{t("models.limitSummary", {
													contextWindow: model.contextWindow,
													maxTokens: model.maxTokens,
												})}
											</span>
										) : null}
									</div>
									{oauthAccount.id === "antigravity" ? (
										<Button
											onClick={() => onTest(oauthAccount.id, modelId)}
											size="xs"
											variant="ghost"
											disabled={busy}
											title={t("models.testTooltip")}
										>
											{t("models.test")}
										</Button>
									) : null}
								</div>
							);
						})}
					</div>
				</div>
			) : null}

			{profile ? (
				<>
				<div className="flex flex-col gap-2 rounded-xl border border-border p-3">
					<div className="flex items-center gap-2">
						<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
							{t("models.enabled")}
						</span>
						<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{enabled.length}
						</span>
						<div className="flex-1" />
						<Button onClick={() => void load(profile)} size="xs" variant="chrome-outline" disabled={busy}>
							<RefreshCwIcon className="size-3.5" />
							{t(available ? "models.refetch" : "models.fetch")}
						</Button>
					</div>
					{enabled.length > 0 ? (
						<div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--app-surface-divider)] pb-2">
							<label className="flex cursor-pointer items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]">
								<Checkbox checked={batchAllSelected} indeterminate={batchSelection.length > 0 && !batchAllSelected}
									disabled={busy} onCheckedChange={() => setBatchPicked(batchAllSelected ? new Set() : new Set(enabled))} />
								{t("models.selectAllEnabled")}
							</label>
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("models.selectedCount", { count: batchSelection.length })}</span>
							<div className="flex-1" />
							<Button size="xs" variant="chrome-outline" disabled={busy || batchSelection.length === 0}
								onClick={() => { setLimitsEditor(null); setBatchEditor(batchSelection); }}>
								{t("models.batchConfigure")}
							</Button>
						</div>
					) : null}

					{enabled.length === 0 ? (
						<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{t("models.enabledEmpty")}
						</p>
					) : (
						<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
							{enabled.map((modelId) => {
								const limits = effectiveLimits(modelId);
								return (
									<div key={modelId} className="flex flex-col gap-1.5 py-1">
										<div className="flex items-center gap-2">
											<Checkbox checked={batchPicked.has(modelId)} disabled={busy}
												onCheckedChange={() => toggleBatch(modelId)} aria-label={t("models.selectModel", { name: modelId })} />
											<div className="flex min-w-0 flex-1 flex-col">
												<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
													{modelId}
												</span>
												<span className="truncate text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
													{t("models.limitSummary", {
														contextWindow: limits.contextWindow,
														maxTokens: limits.maxTokens,
													})}
													{" · "}
													{t(profile.modelThinking?.[modelId] || profile.modelCapabilities?.[modelId]?.thinkingLevels ? "models.thinkingSummary" : "models.thinkingSummaryDefault", {
														levels: effectiveThinkingLevels(profile, modelId).join(" / "),
													})}
												</span>
												<CapabilitySources profile={profile} modelId={modelId} />
											</div>
											<Button
												onClick={() => setLimitsEditor(modelId)}
												size="xs"
												variant="ghost"
												disabled={busy}
											>
												{t("models.configureLimits")}
											</Button>
											<Button
												onClick={() => onTest(profile.id, modelId)}
												size="xs"
												variant="ghost"
												disabled={busy}
												title={t("models.testTooltip")}
											>
												{t("models.test")}
											</Button>
											<Button
												// Never stack two dialogs: the settings one closes first.
												onClick={() => {
													setLimitsEditor(null);
													setRemoving(modelId);
												}}
												size="icon-xs"
												variant="ghost"
												disabled={busy}
												title={t("models.remove")}
											>
												<XIcon className="size-3.5" />
											</Button>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{available ? (
					<div className="flex flex-col gap-2 rounded-xl border border-border p-3">
						<div className="flex items-center gap-2">
							{selectable.length > 0 ? (
								<Checkbox
									checked={allSelected}
									indeterminate={selected.length > 0 && !allSelected}
									onCheckedChange={toggleAll}
									disabled={busy}
									aria-label={t("models.selectAll")}
								/>
							) : null}
							<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
								{t("models.available")}
							</span>
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{available.length}
							</span>
							<span className="flex-1" />
							{selected.length > 0 ? (
								<Button onClick={addPicked} size="xs" variant="chrome-outline" disabled={busy}>
									{t("models.addSelected", { count: String(selected.length) })}
								</Button>
							) : null}
						</div>

						{available.length === 0 ? (
							<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{t("models.fetchEmpty")}
							</p>
						) : (
							<>
								{available.length > SEARCH_THRESHOLD ? (
									<Input
										type="search"
										placeholder={t("models.search")}
										value={query}
										onChange={(event) => setQuery(event.target.value)}
									/>
								) : null}
								{filtered.length === 0 ? (
									<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
										{t("models.noMatch", { query: query.trim() })}
									</p>
								) : (
									<div className="flex max-h-72 flex-col divide-y divide-[color:var(--app-surface-divider)] overflow-y-auto">
										{filtered.map((model) => {
											const added = enabled.includes(model.id);
											return (
												<div key={model.id} className="flex items-center gap-2 py-1">
													{added ? (
														// Holds the column so added rows do not shift left.
														<span aria-hidden="true" className="size-4 shrink-0" />
													) : null}
													<FetchedRow
														added={added}
														checked={picked.has(model.id)}
														disabled={busy}
														id={model.id}
														name={model.name}
														onToggle={() => togglePick(model.id)}
													/>
													{added ? (
														<span className="flex items-center gap-1 px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
															<CheckIcon className="size-3.5" />
															{t("models.added")}
														</span>
													) : (
														<Button
															onClick={() => add(model.id)}
															size="xs"
															variant="chrome-outline"
															disabled={busy}
														>
															{t("models.add")}
														</Button>
													)}
												</div>
											);
										})}
									</div>
								)}
							</>
						)}
					</div>
				) : null}

				{/* Not every OpenAI-compatible endpoint serves /models, so an id can
				    always be typed in by hand. */}
				<div className="flex flex-col gap-1">
					<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("models.manual")}
					</span>
					<div className="flex items-center gap-2">
						<Input
							className="min-w-0 flex-1"
							placeholder="gpt-4o-mini"
							value={manual}
							onChange={(event) => setManual(event.target.value)}
							onKeyDown={(event) => {
								if (event.key !== "Enter" || busy) return;
								add(manual);
								setManual("");
							}}
						/>
						<Button
							onClick={() => {
								add(manual);
								setManual("");
							}}
							size="sm"
							variant="chrome-outline"
							disabled={busy || !manual.trim() || enabled.includes(manual.trim())}
						>
							{t("models.add")}
						</Button>
					</div>
				</div>
				</>
			) : null}

			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setRemoving(null);
				}}
				title={t("models.removeTitle", { name: removing ?? "" })}
				description={t("models.removeDescription")}
				footer={
					<>
						<Button disabled={busy} onClick={() => setRemoving(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								if (!profile || removing === null) return;
								const modelId = removing;
								setRemoving(null);
								setLimitsEditor((current) => (current === modelId ? null : current));
								onSaveModels(
									profile,
									enabled.filter((entry) => entry !== modelId),
								);
							}}
							size="sm"
							variant="destructive"
						>
							{t("models.remove")}
						</Button>
					</>
				}
			/>

			{profile && limitsEditor ? (
				<LimitsDialog
					profile={profile}
					modelId={limitsEditor}
					limits={effectiveLimits(limitsEditor)}
					busy={busy}
					onClose={() => setLimitsEditor(null)}
					onSave={(change) => {
						onSaveModelSettings(profile, [limitsEditor], change);
						setLimitsEditor(null);
					}}
				/>
			) : null}
			{profile && batchEditor ? (
				<BatchLimitsDialog profile={profile} modelIds={batchEditor} busy={busy} onClose={() => setBatchEditor(null)}
					onSave={(change) => { onSaveModelSettings(profile, batchEditor, change); setBatchEditor(null); }} />
			) : null}
		</div>
	);
}

/**
 * A model's own limits and thinking levels, as a modal dialog.
 *
 * A dialog rather than a strip expanded under the row: the editor is a small
 * form, and opening it in place pushed every row below it down the page. Its
 * draft starts from the model's effective settings and is thrown away on close,
 * so dismissing it is the same as cancel — there is no half-edited row left over.
 */
function LimitsDialog({
	profile,
	modelId,
	limits,
	busy,
	onClose,
	onSave,
}: {
	profile: ModelProfileSummary;
	modelId: string;
	limits: ModelTokenLimits;
	busy: boolean;
	onClose: () => void;
	onSave: (change: ModelSettingsChange) => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState({
		contextWindow: String(limits.contextWindow),
		maxTokens: String(limits.maxTokens),
		thinking: effectiveThinkingLevels(profile, modelId),
	});
	const contextWindow = parseLimit(draft.contextWindow, MAX_CONTEXT_WINDOW);
	const maxTokens = parseLimit(draft.maxTokens, MAX_OUTPUT_TOKENS);
	const overridden = !!(profile.modelOverrides?.[modelId] || profile.modelThinking?.[modelId]);

	const save = () => {
		if (contextWindow === null || maxTokens === null) return;
		const limitsChanged =
			contextWindow !== limits.contextWindow || maxTokens !== limits.maxTokens;
		const thinkingChanged = !sameLevels(draft.thinking, effectiveThinkingLevels(profile, modelId));
		// Nothing edited: just close, rather than writing back what was already there.
		if (!limitsChanged && !thinkingChanged) {
			onClose();
			return;
		}
		onSave({
			...(limitsChanged ? { limits: { contextWindow, maxTokens } } : {}),
			...(thinkingChanged ? { thinking: draft.thinking } : {}),
		});
	};

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
					data-settings-surface="dialog"
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
					<div className="flex shrink-0 flex-col gap-1">
						<Dialog.Title className="text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
							{t("models.configureTitle", { name: modelId })}
						</Dialog.Title>
						<Dialog.Description className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{profile.name}
						</Dialog.Description>
					</div>

					<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
						<div className="flex items-start gap-2">
							<label className="flex min-w-0 flex-1 flex-col gap-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
								{t("providers.contextWindow")}
								<Input
									value={draft.contextWindow}
									aria-invalid={contextWindow === null}
									onChange={(event) => setDraft((current) => ({ ...current, contextWindow: event.target.value }))}
								/>
							</label>
							<label className="flex min-w-0 flex-1 flex-col gap-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
								{t("providers.maxTokens")}
								<Input
									value={draft.maxTokens}
									aria-invalid={maxTokens === null}
									onChange={(event) => setDraft((current) => ({ ...current, maxTokens: event.target.value }))}
								/>
							</label>
						</div>
						<p className="text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
							{t("models.modelLimitsHint")}
						</p>
						<CapabilitySources profile={profile} modelId={modelId} />
						<div className="flex flex-col gap-1 border-t border-[color:var(--app-surface-divider)] pt-1.5">
							<span className="text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
								{t("models.thinkingLevels")}
							</span>
							<ThinkingLevelPicker
								value={draft.thinking}
								onChange={(thinking) => setDraft((current) => ({ ...current, thinking }))}
							/>
							<p className="text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
								{t("models.thinkingLevelsHint", {
									levels: defaultThinkingLevels(profile.reasoning).join(" / "),
								})}
							</p>
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-2">
						<Button onClick={onClose} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						{overridden ? (
							<Button
								onClick={() => onSave({ limits: null, thinking: null })}
								size="sm"
								variant="ghost"
								disabled={busy}
							>
								{t("common.reset")}
							</Button>
						) : null}
						<div className="flex-1" />
						<Button
							onClick={save}
							size="sm"
							variant="chrome-outline"
							disabled={busy || contextWindow === null || maxTokens === null}
						>
							{t("common.save")}
						</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function BatchLimitsDialog({ profile, modelIds, busy, onClose, onSave }: {
	profile: ModelProfileSummary;
	modelIds: string[];
	busy: boolean;
	onClose: () => void;
	onSave: (change: ModelSettingsChange) => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState(() => {
		const limits = modelIds.map((id) => effectiveModelLimits(profile, id));
		const levels = modelIds.map((id) => effectiveThinkingLevels(profile, id));
		return {
			contextWindow: limits.every((value) => value.contextWindow === limits[0].contextWindow) ? String(limits[0].contextWindow) : "",
			maxTokens: limits.every((value) => value.maxTokens === limits[0].maxTokens) ? String(limits[0].maxTokens) : "",
			thinking: levels.every((value) => sameLevels(value, levels[0])) ? levels[0] : [],
			applyContext: false, applyOutput: false, applyThinking: false,
		};
	});
	const contextWindow = parseLimit(draft.contextWindow, MAX_CONTEXT_WINDOW);
	const maxTokens = parseLimit(draft.maxTokens, MAX_OUTPUT_TOKENS);
	const valid = (draft.applyContext || draft.applyOutput || draft.applyThinking) &&
		(!draft.applyContext || contextWindow !== null) && (!draft.applyOutput || maxTokens !== null) &&
		(!draft.applyThinking || draft.thinking.length > 0);
	const save = () => {
		if (!valid) return;
		onSave({
			...(draft.applyContext || draft.applyOutput ? { limits: {
				...(draft.applyContext && contextWindow !== null ? { contextWindow } : {}),
				...(draft.applyOutput && maxTokens !== null ? { maxTokens } : {}),
			} } : {}),
			...(draft.applyThinking ? { thinking: draft.thinking } : {}),
		});
	};
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]" />
				<Dialog.Popup data-settings-surface="dialog" className={cn(
					"fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-4rem)] w-[32rem] max-w-[calc(100vw-3rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-hidden rounded-2xl border bg-popover p-4 text-popover-foreground shadow-2xl outline-none",
					RAISED_SURFACE_BORDER_CLASS_NAME,
				)}>
					<Dialog.Title className="text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">{t("models.batchTitle", { count: modelIds.length })}</Dialog.Title>
					<Dialog.Description className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{profile.name} · {t("models.batchHint")}</Dialog.Description>
					<div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
						<div className="max-h-20 overflow-y-auto break-all font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{modelIds.join(" · ")}</div>
						{(["contextWindow", "maxTokens"] as const).map((key) => {
							const flag = key === "contextWindow" ? "applyContext" : "applyOutput";
							const invalid = draft[flag] && (key === "contextWindow" ? contextWindow : maxTokens) === null;
							return <div key={key} className="flex flex-col gap-1.5">
								<label className="flex items-center gap-2 text-[length:var(--app-font-size-ui,12px)]">
									<Checkbox checked={draft[flag]} disabled={busy} onCheckedChange={(checked) => setDraft((current) => ({ ...current, [flag]: checked === true }))} />
									{t(key === "contextWindow" ? "providers.contextWindow" : "providers.maxTokens")}
								</label>
								<Input aria-label={t(key === "contextWindow" ? "providers.contextWindow" : "providers.maxTokens")}
									disabled={!draft[flag] || busy} value={draft[key]} aria-invalid={invalid} inputMode="numeric"
									placeholder={t("models.batchMixed")} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} />
								{invalid ? <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{t("models.batchLimitRange", { min: MIN_TOKEN_LIMIT, max: key === "contextWindow" ? MAX_CONTEXT_WINDOW : MAX_OUTPUT_TOKENS })}</p> : null}
							</div>;
						})}
						<div className="flex flex-col gap-1.5">
							<label className="flex items-center gap-2 text-[length:var(--app-font-size-ui,12px)]">
								<Checkbox checked={draft.applyThinking} disabled={busy} onCheckedChange={(checked) => setDraft((current) => ({ ...current, applyThinking: checked === true }))} />
								{t("models.thinkingLevels")}
							</label>
							<fieldset disabled={!draft.applyThinking || busy} className="disabled:opacity-50">
								<ThinkingLevelPicker value={draft.thinking} onChange={(thinking) => setDraft((current) => ({ ...current, thinking }))} />
							</fieldset>
							<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("models.batchThinkingHint")}</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave({ limits: null, thinking: null })}>{t("models.batchReset")}</Button>
						<div className="flex-1" />
						<Button size="sm" variant="chrome-outline" disabled={busy || !valid} onClick={save}>{t("models.batchApply", { count: modelIds.length })}</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
