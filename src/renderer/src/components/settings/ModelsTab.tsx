import { useEffect, useState } from "react";
import {
	MAX_CONTEXT_WINDOW,
	MAX_OUTPUT_TOKENS,
	MIN_TOKEN_LIMIT,
	type FetchedModel,
	type ModelProfileSummary,
	type ModelTokenLimits,
	type OAuthProviderSummary,
} from "../../../../shared/settings";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { CheckIcon, PlusIcon, RefreshCwIcon, XIcon } from "../../lib/icons";

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
	onSaveModelLimits,
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
	/** `null` clears the override; the model falls back to the provider defaults. */
	onSaveModelLimits: (profile: ModelProfileSummary, modelId: string, limits: ModelTokenLimits | null) => void;
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
	/** The one expanded per-model limits editor; drafts stay strings until saved. */
	const [limitsEditor, setLimitsEditor] = useState<{
		modelId: string;
		contextWindow: string;
		maxTokens: string;
	} | null>(null);

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

	const parseLimit = (raw: string, max: number): number | null => {
		const value = Number(raw.trim());
		return Number.isInteger(value) && value >= MIN_TOKEN_LIMIT && value <= max
			? value
			: null;
	};

	const effectiveLimits = (modelId: string): ModelTokenLimits =>
		profile?.modelOverrides?.[modelId] ?? {
			contextWindow: profile?.contextWindow ?? 0,
			maxTokens: profile?.maxTokens ?? 0,
		};

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

					{enabled.length === 0 ? (
						<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{t("models.enabledEmpty")}
						</p>
					) : (
						<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
							{enabled.map((modelId) => {
								const limits = effectiveLimits(modelId);
								const editing = limitsEditor?.modelId === modelId;
								const draftContext = editing
									? parseLimit(limitsEditor.contextWindow, MAX_CONTEXT_WINDOW)
									: null;
								const draftOutput = editing
									? parseLimit(limitsEditor.maxTokens, MAX_OUTPUT_TOKENS)
									: null;
								return (
									<div key={modelId} className="flex flex-col gap-1.5 py-1">
										<div className="flex items-center gap-2">
											<div className="flex min-w-0 flex-1 flex-col">
												<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
													{modelId}
												</span>
												<span className="truncate text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
													{t("models.limitSummary", {
														contextWindow: limits.contextWindow,
														maxTokens: limits.maxTokens,
													})}
												</span>
											</div>
											<Button
												onClick={() =>
													setLimitsEditor(
														editing
															? null
															: {
																	modelId,
																	contextWindow: String(limits.contextWindow),
																	maxTokens: String(limits.maxTokens),
																},
													)
												}
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
												onClick={() => {
													if (editing) setLimitsEditor(null);
													onSaveModels(
														profile,
														enabled.filter((entry) => entry !== modelId),
													);
												}}
												size="icon-xs"
												variant="ghost"
												disabled={busy}
												title={t("models.remove")}
											>
												<XIcon className="size-3.5" />
											</Button>
										</div>
										{editing && limitsEditor ? (
											<div className="flex flex-col gap-1.5 rounded-lg border border-border px-2 py-2">
												<div className="flex items-start gap-2">
													<label className="flex min-w-0 flex-1 flex-col gap-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
														{t("providers.contextWindow")}
														<Input
															value={limitsEditor.contextWindow}
															aria-invalid={draftContext === null}
															onChange={(event) =>
																setLimitsEditor((current) =>
																	current ? { ...current, contextWindow: event.target.value } : current,
																)
															}
														/>
													</label>
													<label className="flex min-w-0 flex-1 flex-col gap-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
														{t("providers.maxTokens")}
														<Input
															value={limitsEditor.maxTokens}
															aria-invalid={draftOutput === null}
															onChange={(event) =>
																setLimitsEditor((current) =>
																	current ? { ...current, maxTokens: event.target.value } : current,
																)
															}
														/>
													</label>
												</div>
												<p className="text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
													{t("models.modelLimitsHint")}
												</p>
												<div className="flex items-center gap-2">
													<Button
														onClick={() => setLimitsEditor(null)}
														size="xs"
														variant="ghost"
													>
														{t("common.cancel")}
													</Button>
													{profile.modelOverrides?.[modelId] ? (
														<Button
															onClick={() => {
																onSaveModelLimits(profile, modelId, null);
																setLimitsEditor(null);
															}}
															size="xs"
															variant="ghost"
															disabled={busy}
														>
															{t("common.reset")}
														</Button>
													) : null}
													<div className="flex-1" />
													<Button
														onClick={() => {
															if (draftContext === null || draftOutput === null) return;
															onSaveModelLimits(profile, modelId, {
																contextWindow: draftContext,
																maxTokens: draftOutput,
															});
															setLimitsEditor(null);
														}}
														size="xs"
														variant="chrome-outline"
														disabled={busy || draftContext === null || draftOutput === null}
													>
														{t("common.save")}
													</Button>
												</div>
											</div>
										) : null}
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
		</div>
	);
}
