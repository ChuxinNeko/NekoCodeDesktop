import { useEffect, useState } from "react";
import type {
	FetchedModel,
	ModelProfileSummary,
	OAuthProviderSummary,
} from "../../../../shared/settings";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CheckIcon, PlusIcon, RefreshCwIcon, XIcon } from "../../lib/icons";

/** Below this many entries the list is short enough to scan without a filter. */
const SEARCH_THRESHOLD = 8;

/**
 * Picks which of a provider's models this app may use.
 *
 * Every add/remove writes straight through to the provider — there is no second
 * save step, because a half-applied model list is not a state worth having.
 */
export function ModelsTab({
	profiles,
	accounts,
	profile,
	busy,
	autoFetchId,
	onSelect,
	onAutoFetchHandled,
	onFetch,
	onSaveModels,
	onTest,
	onAddProvider,
}: {
	profiles: ModelProfileSummary[];
	/** Signed-in subscriptions: listed, not picked from — see the note below. */
	accounts: OAuthProviderSummary[];
	profile: ModelProfileSummary | null;
	busy: boolean;
	/** A provider that was just created: pull its list without being asked. */
	autoFetchId: string | null;
	onSelect: (id: string) => void;
	onAutoFetchHandled: () => void;
	onFetch: (profile: ModelProfileSummary) => Promise<FetchedModel[] | null>;
	onSaveModels: (profile: ModelProfileSummary, modelIds: string[]) => void;
	onTest: (profileId: string, modelId: string) => void;
	onAddProvider: () => void;
}) {
	const { t } = useTranslation();
	// Keyed by provider so switching back and forth does not re-hit the network.
	const [fetched, setFetched] = useState<Record<string, FetchedModel[]>>({});
	const [query, setQuery] = useState("");
	const [manual, setManual] = useState("");

	const load = async (target: ModelProfileSummary) => {
		const result = await onFetch(target);
		if (result) setFetched((prev) => ({ ...prev, [target.id]: result }));
	};

	// Clearing the request first is what keeps this to one fetch: the effect
	// re-runs on the cleared id and falls straight out.
	const profileId = profile?.id ?? null;
	useEffect(() => {
		if (!profile || autoFetchId !== profile.id) return;
		onAutoFetchHandled();
		void load(profile);
	}, [autoFetchId, profileId]);

	// A subscription's model list is the provider's to decide, so it is stated
	// here rather than offered as a choice this page cannot honour.
	const subscriptions = accounts.filter((account) => account.signedIn && account.modelIds.length > 0);
	const subscriptionNote =
		subscriptions.length > 0 ? (
			<div className="flex flex-col gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				<p>
				{t("models.oauthNote", {
					providers: subscriptions.map((account) => account.name).join(" · "),
					count: subscriptions.reduce((total, account) => total + account.modelIds.length, 0),
				})}
				</p>
				{subscriptions.filter((account) => account.id === "antigravity").map((account) => (
					<div key={account.id} className="flex flex-col gap-1">
						{account.modelIds.map((modelId) => (
							<div key={modelId} className="flex items-center gap-2 py-1">
								<span className="min-w-0 flex-1 truncate font-mono">{modelId}</span>
								<Button size="xs" variant="chrome-outline" disabled={busy} onClick={() => onTest(account.id, modelId)}>{t("models.test")}</Button>
							</div>
						))}
					</div>
				))}
			</div>
		) : null;

	if (profiles.length === 0 || !profile) {
		return (
			<div className="flex flex-col gap-3">
				{subscriptionNote}
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

	const enabled = profile.modelIds;
	const available = fetched[profile.id] ?? null;
	const needle = query.trim().toLowerCase();
	const filtered = (available ?? []).filter(
		(model) =>
			!needle ||
			model.id.toLowerCase().includes(needle) ||
			model.name.toLowerCase().includes(needle),
	);

	const add = (modelId: string) => {
		const id = modelId.trim();
		if (!id || enabled.includes(id)) return;
		onSaveModels(profile, [...enabled, id]);
	};

	return (
		<div className="flex flex-col gap-3">
			{subscriptionNote}
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
							}}
							className={cn(
								"flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								entry.id === profile.id
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
				</div>
			</div>

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
						{enabled.map((modelId) => (
							<div key={modelId} className="flex items-center gap-2 py-1">
								<span className="min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
									{modelId}
								</span>
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
									onClick={() =>
										onSaveModels(
											profile,
											enabled.filter((entry) => entry !== modelId),
										)
									}
									size="icon-xs"
									variant="ghost"
									disabled={busy}
									title={t("models.remove")}
								>
									<XIcon className="size-3.5" />
								</Button>
							</div>
						))}
					</div>
				)}
			</div>

			{available ? (
				<div className="flex flex-col gap-2 rounded-xl border border-border p-3">
					<div className="flex items-center gap-2">
						<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
							{t("models.available")}
						</span>
						<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{available.length}
						</span>
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
												<div className="flex min-w-0 flex-1 flex-col">
													<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
														{model.id}
													</span>
													{model.name !== model.id ? (
														<span className="truncate text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
															{model.name}
														</span>
													) : null}
												</div>
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
		</div>
	);
}
