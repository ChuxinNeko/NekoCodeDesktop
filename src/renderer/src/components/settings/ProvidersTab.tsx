import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	MAX_CONTEXT_WINDOW,
	MAX_OUTPUT_TOKENS,
	MIN_TOKEN_LIMIT,
	type ModelApiProtocol,
	type ModelProfileSummary,
	type OAuthLoginOptions,
	type OAuthProviderId,
	type OAuthProviderSummary,
	type ProviderKind,
} from "../../../../shared/settings";
import {
	PROTOCOL_DEFAULT_ROUTE,
	PROTOCOL_SUFFIX,
	parseFullEndpoint,
} from "../../../../shared/model-protocol";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { CheckIcon, CopyIcon, ExternalLinkIcon, PencilIcon, PlusIcon, TrashCanIcon } from "../../lib/icons";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { OAuthUsage } from "./OAuthUsage";
import type { OAuthLoginState } from "./ProviderModelSettings";

export { PROTOCOL_DEFAULT_ROUTE };

export const PROTOCOL_LABELS: Record<ModelApiProtocol, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
};

/** What signing into each subscription involves, shown under the provider picker. */
const OAUTH_HINT_KEYS: Record<OAuthProviderId, TranslationKey> = {
	"openai-codex": "oauth.formHint",
	"github-copilot": "oauth.hint.githubCopilot",
	openrouter: "oauth.hint.openrouter",
	"kimi-coding": "oauth.hint.kimiCoding",
	xai: "oauth.hint.xai",
	radius: "oauth.hint.radius",
	antigravity: "oauth.antigravityHint",
};

/** Options a sign-in needs from the form; only Copilot asks for any. */
function loginOptionsOf(draft: ProviderDraft): OAuthLoginOptions | undefined {
	const domain = draft.enterpriseDomain.trim();
	return draft.oauthProvider === "github-copilot" && domain ? { enterpriseDomain: domain } : undefined;
}

export const PROVIDER_KIND_LABEL_KEYS: Record<ProviderKind, TranslationKey> = {
	"custom-api": "providers.kind.customApi",
	oauth: "providers.kind.oauth",
};

/**
 * The provider form's fields. Models are deliberately absent: they belong to
 * the models tab, which pulls them from the endpoint this form saves.
 *
 * An OAuth draft uses almost none of this — it is a provider to sign into, not
 * an endpoint to describe — but it shares the form so the type dropdown can
 * switch between the two without the rest of the page moving.
 */
export interface ProviderDraft {
	id?: string;
	kind: ProviderKind;
	/** Which provider to sign into, when the kind is `oauth`. */
	oauthProvider: OAuthProviderId;
	/** GitHub Enterprise domain for Copilot; blank is github.com. */
	enterpriseDomain: string;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	apiKey: string;
	reasoning: boolean;
	imageInput: boolean;
	/**
	 * Token limits, held as typed text so a half-deleted number does not snap
	 * back to a default mid-edit. Parsed on save.
	 */
	contextWindow: string;
	maxTokens: string;
	/** The route field stays folded away until an endpoint needs a custom path. */
	advanced: boolean;
	/**
	 * Enter the endpoint as one address instead of a base, a route and a
	 * protocol. Held on the draft only — what gets saved is still the three
	 * fields, parsed out of the URL as it is typed.
	 */
	fullUrl: boolean;
	/** What the user typed in full-URL mode, parsed or not. */
	fullUrlText: string;
}

/**
 * Take a typed endpoint URL into the fields the backend stores.
 *
 * A URL that does not parse blanks the base rather than leaving the last good
 * one behind it: save is gated on the base, so a half-typed address cannot ride
 * in on the back of whatever was there before.
 */
export function applyFullUrl(draft: ProviderDraft, text: string): ProviderDraft {
	const parsed = parseFullEndpoint(text);
	return parsed
		? { ...draft, fullUrlText: text, baseUrl: parsed.baseUrl, route: parsed.route, api: parsed.api }
		: { ...draft, fullUrlText: text, baseUrl: "" };
}

/** Flip between one endpoint field and the base/route/protocol trio. */
export function setFullUrlMode(draft: ProviderDraft, fullUrl: boolean): ProviderDraft {
	if (!fullUrl) return { ...draft, fullUrl: false };
	const text = draft.baseUrl.trim()
		? `${draft.baseUrl.trim().replace(/\/+$/, "")}${draft.route}`
		: draft.fullUrlText;
	return { ...applyFullUrl(draft, text), fullUrl: true };
}

/** A limit the backend would accept — blank is not one, the field is required. */
function parseTokenLimit(value: string, max: number): number | null {
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) && parsed >= MIN_TOKEN_LIMIT && parsed <= max
		? parsed
		: null;
}

export function draftContextWindow(draft: ProviderDraft): number | null {
	return parseTokenLimit(draft.contextWindow, MAX_CONTEXT_WINDOW);
}

export function draftMaxTokens(draft: ProviderDraft): number | null {
	return parseTokenLimit(draft.maxTokens, MAX_OUTPUT_TOKENS);
}

export function emptyProviderDraft(): ProviderDraft {
	return {
		kind: "custom-api",
		oauthProvider: "openai-codex",
		enterpriseDomain: "",
		name: "",
		baseUrl: "",
		route: PROTOCOL_DEFAULT_ROUTE["openai-completions"],
		api: "openai-completions",
		apiKey: "",
		reasoning: false,
		imageInput: false,
		contextWindow: String(DEFAULT_CONTEXT_WINDOW),
		maxTokens: String(DEFAULT_MAX_TOKENS),
		advanced: false,
		fullUrl: false,
		fullUrlText: "",
	};
}

export function providerDraftFrom(profile: ModelProfileSummary): ProviderDraft {
	return {
		id: profile.id,
		kind: profile.kind,
		oauthProvider: "openai-codex",
		enterpriseDomain: "",
		name: profile.name,
		baseUrl: profile.baseUrl,
		route: profile.route,
		api: profile.api,
		apiKey: "",
		reasoning: profile.reasoning,
		imageInput: profile.imageInput,
		contextWindow: String(profile.contextWindow),
		maxTokens: String(profile.maxTokens),
		// A saved endpoint whose route is not the protocol default only got there
		// on purpose, so keep it in sight while editing.
		advanced:
			profile.contextWindow !== DEFAULT_CONTEXT_WINDOW ||
			profile.maxTokens !== DEFAULT_MAX_TOKENS,
		// A stored route that is not the protocol default only got there on
		// purpose, so reopen it the way it was most likely entered.
		fullUrl: profile.route !== PROTOCOL_DEFAULT_ROUTE[profile.api],
		fullUrlText: `${profile.baseUrl.replace(/\/+$/, "")}${profile.route}`,
	};
}

/** A draft that the backend would accept — save stays disabled until then. */
export function isDraftComplete(draft: ProviderDraft): boolean {
	return (
		draft.name.trim().length > 0 &&
		draft.baseUrl.trim().length > 0 &&
		draft.route.trim().length > 0 &&
		draftContextWindow(draft) !== null &&
		draftMaxTokens(draft) !== null &&
		// Editing keeps the stored key when the field is left blank; creating
		// cannot, because there is nothing stored yet.
		(draft.id !== undefined || draft.apiKey.trim().length > 0)
	);
}

export function ProvidersTab({
	profiles,
	accounts,
	login,
	draft,
	busy,
	onDraftChange,
	onSave,
	onDelete,
	onLogin,
	onCancelLogin,
	onSubmitCode,
	onLogout,
	onRefresh,
	onManageModels,
}: {
	profiles: ModelProfileSummary[];
	accounts: OAuthProviderSummary[];
	login: OAuthLoginState | null;
	draft: ProviderDraft | null;
	busy: boolean;
	onDraftChange: (draft: ProviderDraft | null) => void;
	onSave: () => void;
	onDelete: (id: string) => void;
	onLogin: (provider: OAuthProviderId, options?: OAuthLoginOptions) => void;
	onCancelLogin: () => void;
	onSubmitCode: (code: string) => void;
	onLogout: (provider: OAuthProviderId) => void;
	onRefresh?: (provider: OAuthProviderId) => void;
	onManageModels: (id: string) => void;
}) {
	const { t } = useTranslation();
	// Deleting a provider takes its key with it, so the trash icon arms a second
	// click rather than firing on the first.
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [pastedCode, setPastedCode] = useState("");
	const signedIn = accounts.filter((account) => account.signedIn);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("providers.count", { count: profiles.length + signedIn.length })}
				</span>
				<div className="flex-1" />
				<Button
					onClick={() => onDraftChange(emptyProviderDraft())}
					size="sm"
					variant="subtle"
					disabled={draft !== null}
				>
					<PlusIcon className="size-3.5" />
					{t("providers.add")}
				</Button>
			</div>

			{login ? (
				<div className="flex flex-col gap-2 rounded-xl border border-[color:var(--color-border-focus)] p-3">
					<div className="flex items-center gap-2">
						<Spinner className="size-3.5 text-muted-foreground" />
						<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
							{login.deviceCode
								? t("oauth.waitingDevice", {
										name: accounts.find((account) => account.id === login.provider)?.name ?? login.provider,
									})
								: t("oauth.waiting")}
						</span>
						<div className="flex-1" />
						<Button onClick={onCancelLogin} size="xs" variant="ghost">
							{t("common.cancel")}
						</Button>
					</div>
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{login.message ?? t(login.deviceCode ? "oauth.deviceCodeHint" : "oauth.browserHint")}
					</p>
					{login.deviceCode ? <DeviceCode code={login.deviceCode} /> : null}
					{login.url ? (
						<a
							href={login.url}
							target="_blank"
							rel="noreferrer"
							className="flex items-center gap-1 truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground underline-offset-2 hover:underline"
						>
							<ExternalLinkIcon className="size-3 shrink-0" />
							<span className="truncate">{login.url}</span>
						</a>
					) : null}
					{/* The callback lands on a fixed local port. When something else
					    holds it, pasting the redirect URL is the way through. */}
					{login.manual ? (
						<>
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{t("oauth.manualHint")}
							</span>
							<div className="flex items-center gap-2">
								<Input
									className="min-w-0 flex-1"
									placeholder={t(login.provider === "antigravity" ? "oauth.callbackPlaceholder" : "oauth.codePlaceholder")}
									value={pastedCode}
									onChange={(event) => setPastedCode(event.target.value)}
									onKeyDown={(event) => {
										if (event.key !== "Enter" || !pastedCode.trim()) return;
										onSubmitCode(pastedCode);
										setPastedCode("");
									}}
								/>
								<Button
									onClick={() => {
										onSubmitCode(pastedCode);
										setPastedCode("");
									}}
									size="sm"
									variant="chrome-outline"
									disabled={!pastedCode.trim()}
								>
									{t("oauth.submitCode")}
								</Button>
							</div>
						</>
					) : null}
				</div>
			) : null}

			{signedIn.length > 0 ? (
				<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-border">
					{signedIn.map((account) => (
						<div key={account.id} className="flex flex-col gap-1 px-3 py-2">
							<div className="flex items-center gap-2">
								<span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
									{account.name}
								</span>
								<span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
									{t("providers.kind.oauth")}
									{account.plan ? ` · ${account.plan}` : ""}
								</span>
								<div className="flex-1" />
								{account.id === "antigravity" && onRefresh ? (
									<Button onClick={() => onRefresh(account.id)} size="xs" variant="chrome-outline" disabled={login !== null || busy}>
										{t("oauth.refresh")}
									</Button>
								) : null}
								<Button
									// Copilot signs back into the same GitHub it was signed into.
									onClick={() =>
										onLogin(
											account.id,
											account.id === "github-copilot" && account.accountId
												? { enterpriseDomain: account.accountId }
												: undefined,
										)
									}
									size="xs"
									variant="chrome-outline"
									disabled={login !== null || busy}
								>
									{t("oauth.reLogin")}
								</Button>
								<Button
									onClick={() => onLogout(account.id)}
									size="xs"
									variant="destructive-outline"
									disabled={login !== null || busy}
								>
									{t("oauth.logout")}
								</Button>
							</div>
							<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{account.email ?? account.accountId ?? t("oauth.signedInUnknown")}
							</span>
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{t("providers.modelCount", { count: account.modelIds.length })} · {t("oauth.modelsManaged")}
							</span>
							<OAuthUsage provider={account.id} />
						</div>
					))}
				</div>
			) : null}

			<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-border">
				{profiles.length === 0 ? (
					<p className="px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("providers.empty")}
					</p>
				) : (
					profiles.map((profile) => (
						<div key={profile.id} className="flex flex-col gap-1 px-3 py-2">
							<div className="flex items-center gap-2">
								<span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
									{profile.name}
								</span>
								<span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
									{t(PROVIDER_KIND_LABEL_KEYS[profile.kind])}
									{profile.kind === "custom-api" ? ` · ${PROTOCOL_LABELS[profile.api]}` : ""}
								</span>
								<div className="flex-1" />
								{confirmId === profile.id ? (
									<>
										<Button
											onClick={() => setConfirmId(null)}
											size="xs"
											variant="ghost"
											disabled={busy}
										>
											{t("common.cancel")}
										</Button>
										<Button
											onClick={() => {
												setConfirmId(null);
												onDelete(profile.id);
											}}
											size="xs"
											variant="destructive-outline"
											disabled={busy}
										>
											{t("providers.confirmDelete")}
										</Button>
									</>
								) : (
									<>
										<Button
											onClick={() => onManageModels(profile.id)}
											size="xs"
											variant="chrome-outline"
										>
											{t("providers.manageModels")}
										</Button>
										<Button
											onClick={() => onDraftChange(providerDraftFrom(profile))}
											size="icon-xs"
											variant="chrome-outline"
											title={t("common.edit")}
										>
											<PencilIcon className="size-3.5" />
										</Button>
										<Button
											onClick={() => setConfirmId(profile.id)}
											size="icon-xs"
											variant="destructive-outline"
											title={t("common.delete")}
										>
											<TrashCanIcon className="size-3.5" />
										</Button>
									</>
								)}
							</div>
							<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{profile.baseUrl}
								{profile.route}
							</span>
							<span
								className={cn(
									"text-[length:var(--app-font-size-ui-xs,10px)]",
									profile.modelIds.length === 0 ? "text-[var(--warning)]" : "text-muted-foreground",
								)}
							>
								{profile.modelIds.length === 0
									? t("providers.noModels")
									: t("providers.modelCount", { count: profile.modelIds.length })}
							</span>
						</div>
					))
				)}
			</div>
			{draft ? (
				<ProviderForm
					draft={draft}
					accounts={accounts}
					busy={busy}
					loginInFlight={login !== null}
					onDraftChange={onDraftChange}
					onSave={onSave}
					onLogin={onLogin}
				/>
			) : null}
		</div>
	);
}

/**
 * The add/edit form, as a modal dialog.
 *
 * The type dropdown swaps its whole body: a custom API is an endpoint to
 * describe, a subscription is an account to sign into, and below the type the
 * two share nothing — not even a save button, since signing in is the save.
 *
 * A dialog rather than an inline card: the form pauses the list underneath
 * until it is answered, and dismissing it — Escape, the backdrop, or Cancel —
 * is the same action, discarding the draft.
 */
function ProviderForm({
	draft,
	accounts,
	busy,
	loginInFlight,
	onDraftChange,
	onSave,
	onLogin,
}: {
	draft: ProviderDraft;
	accounts: OAuthProviderSummary[];
	busy: boolean;
	loginInFlight: boolean;
	onDraftChange: (draft: ProviderDraft | null) => void;
	onSave: () => void;
	onLogin: (provider: OAuthProviderId, options?: OAuthLoginOptions) => void;
}) {
	const { t } = useTranslation();

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onDraftChange(null); }}>
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
						{t(draft.id ? "providers.editTitle" : "providers.addTitle")}
					</Dialog.Title>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
						<div className="flex flex-col gap-1">
							<Label>{t("providers.kind")}</Label>
							<Select
								value={draft.kind}
								onValueChange={(value) => {
									if (value) onDraftChange({ ...draft, kind: value as ProviderKind });
								}}
								// An existing endpoint cannot turn into a subscription; the two keep
								// entirely different things on disk.
								disabled={draft.id !== undefined}
							>
								<SelectTrigger size="sm">
									<SelectValue>{t(PROVIDER_KIND_LABEL_KEYS[draft.kind])}</SelectValue>
								</SelectTrigger>
								<SelectPopup surface="settings">
									<SelectItem value="custom-api">{t("providers.kind.customApi")}</SelectItem>
									<SelectItem value="oauth">{t("providers.kind.oauth")}</SelectItem>
								</SelectPopup>
							</Select>
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{t(draft.kind === "oauth" ? "providers.kindHintOauth" : "providers.kindHint")}
							</span>
						</div>

						{draft.kind === "oauth" ? (
							<>
								<div className="flex flex-col gap-1">
									<Label>{t("oauth.provider")}</Label>
									<Select
										value={draft.oauthProvider}
										onValueChange={(value) => {
											if (value) onDraftChange({ ...draft, oauthProvider: value as OAuthProviderId });
										}}
									>
										<SelectTrigger size="sm">
											<SelectValue>
												{accounts.find((account) => account.id === draft.oauthProvider)?.name ??
													draft.oauthProvider}
											</SelectValue>
										</SelectTrigger>
										<SelectPopup surface="settings">
											{accounts.map((account) => (
												<SelectItem key={account.id} value={account.id}>
													{account.name}
												</SelectItem>
											))}
										</SelectPopup>
									</Select>
									<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
										{t(OAUTH_HINT_KEYS[draft.oauthProvider])}
									</span>
								</div>
								{draft.oauthProvider === "github-copilot" ? (
									<div className="flex flex-col gap-1">
										<Label>{t("oauth.enterpriseDomain")}</Label>
										<Input
											placeholder="company.ghe.com"
											value={draft.enterpriseDomain}
											onChange={(event) => onDraftChange({ ...draft, enterpriseDomain: event.target.value })}
										/>
										<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
											{t("oauth.enterpriseDomainHint")}
										</span>
									</div>
								) : null}
							</>
						) : (
							<>
								<div className={draft.fullUrl ? "flex flex-col gap-1" : "grid grid-cols-2 gap-3"}>
									<div className="flex flex-col gap-1">
										<Label>{t("common.name")}</Label>
										<Input
											placeholder={t("providers.namePlaceholder")}
											value={draft.name}
											onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
										/>
									</div>
									{/* In full-URL mode the protocol is read off the address instead of
									    picked: each one ends its path differently, so the URL already
									    says which it is. */}
									{draft.fullUrl ? null : (
										<div className="flex flex-col gap-1">
											<Label>{t("providers.protocol")}</Label>
											<Select
												value={draft.api}
												onValueChange={(value) => {
													if (!value) return;
													const nextApi = value as ModelApiProtocol;
													onDraftChange({
														...draft,
														api: nextApi,
														// The route carries a protocol-specific suffix the backend
														// enforces, so switching protocol resets it.
														route: PROTOCOL_DEFAULT_ROUTE[nextApi],
													});
												}}
											>
												<SelectTrigger size="sm">
													<SelectValue>{PROTOCOL_LABELS[draft.api]}</SelectValue>
												</SelectTrigger>
												<SelectPopup surface="settings">
													{Object.entries(PROTOCOL_LABELS).map(([value, label]) => (
														<SelectItem key={value} value={value}>
															{label}
														</SelectItem>
													))}
												</SelectPopup>
											</Select>
										</div>
									)}
								</div>

								<label className="flex items-center justify-between gap-3">
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="text-[length:var(--app-font-size-ui,12px)]">
											{t("providers.fullUrl")}
										</span>
										<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
											{t("providers.fullUrlHint")}
										</span>
									</span>
									<Switch
										checked={draft.fullUrl}
										onCheckedChange={(checked) => onDraftChange(setFullUrlMode(draft, checked))}
									/>
								</label>

								{draft.fullUrl ? (
									<div className="flex flex-col gap-1">
										<Label>{t("providers.endpointUrl")}</Label>
										<Input
											placeholder="https://ark.cn-beijing.volces.com/api/v3/chat/completions"
											value={draft.fullUrlText}
											aria-invalid={draft.fullUrlText.trim().length > 0 && !draft.baseUrl}
											onChange={(event) => onDraftChange(applyFullUrl(draft, event.target.value))}
										/>
										<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
											{draft.fullUrlText.trim().length === 0
												? t("providers.fullUrlHint")
												: draft.baseUrl
													? t("providers.protocolDetected", { protocol: PROTOCOL_LABELS[draft.api] })
													: t("providers.fullUrlInvalid", {
															suffixes: Object.values(PROTOCOL_SUFFIX).join(" / "),
														})}
										</span>
									</div>
								) : (
									<div className="flex flex-col gap-1">
										<Label>{t("providers.baseUrl")}</Label>
										<Input
											placeholder="https://api.example.com"
											value={draft.baseUrl}
											onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })}
										/>
										{draft.baseUrl.trim() ? (
											<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
												{t("providers.endpointPreview", {
													url: `${draft.baseUrl.trim().replace(/\/+$/, "")}${draft.route}`,
												})}
											</span>
										) : null}
									</div>
								)}
								<div className="flex flex-col gap-1">
									<Label>
										{t("providers.apiKey")} {draft.id ? t("providers.apiKeyKeep") : ""}
									</Label>
									<Input
										type="password"
										placeholder={draft.id ? "••••••••" : ""}
										value={draft.apiKey}
										onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
									/>
								</div>

								<button
									type="button"
									onClick={() => onDraftChange({ ...draft, advanced: !draft.advanced })}
									className="self-start text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground transition-colors hover:text-foreground"
								>
									{draft.advanced ? t("providers.hideAdvanced") : t("providers.showAdvanced")}
								</button>
								{draft.advanced ? (
									<>
										{draft.fullUrl ? null : (
											<div className="flex flex-col gap-1">
												<Label>{t("providers.route")}</Label>
												<Input
													value={draft.route}
													onChange={(event) => onDraftChange({ ...draft, route: event.target.value })}
												/>
											</div>
										)}
										{/* A custom endpoint advertises neither limit, so both are
										    declared here. The output ceiling is the one that decides
										    whether a long file can be written in a single response. */}
										<div className="flex gap-2">
											<div className="flex min-w-0 flex-1 flex-col gap-1">
												<Label>{t("providers.contextWindow")}</Label>
												<Input
													inputMode="numeric"
													value={draft.contextWindow}
													aria-invalid={draftContextWindow(draft) === null}
													onChange={(event) =>
														onDraftChange({ ...draft, contextWindow: event.target.value })
													}
												/>
											</div>
											<div className="flex min-w-0 flex-1 flex-col gap-1">
												<Label>{t("providers.maxTokens")}</Label>
												<Input
													inputMode="numeric"
													value={draft.maxTokens}
													aria-invalid={draftMaxTokens(draft) === null}
													onChange={(event) =>
														onDraftChange({ ...draft, maxTokens: event.target.value })
													}
												/>
											</div>
										</div>
										<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
											{t("providers.tokenLimitsHint")}
										</span>
									</>
								) : null}

								{/* PI clamps every thinking level to "off" unless the model is flagged
								    as reasoning-capable, and an OpenAI-compatible endpoint does not
								    advertise that — so it has to be declared here. */}
								<div className="flex items-start gap-3">
									<div className="flex min-w-0 flex-1 flex-col">
										<Label>{t("providers.reasoning")}</Label>
										<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
											{t("providers.reasoningHint")}
										</span>
									</div>
									<Button
										onClick={() => onDraftChange({ ...draft, reasoning: !draft.reasoning })}
										size="sm"
										variant={draft.reasoning ? "subtle" : "chrome-outline"}
									>
										{draft.reasoning ? t("common.on") : t("common.off")}
									</Button>
								</div>

								<div className="flex items-start gap-3">
									<div className="flex min-w-0 flex-1 flex-col">
										<Label>{t("providers.imageInput")}</Label>
										<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
											{t("providers.imageInputHint")}
										</span>
									</div>
									<Button
										onClick={() => onDraftChange({ ...draft, imageInput: !draft.imageInput })}
										size="sm"
										variant={draft.imageInput ? "subtle" : "chrome-outline"}
									>
										{draft.imageInput ? t("common.on") : t("common.off")}
									</Button>
								</div>
							</>
						)}
					</div>
					{/* One footer for both kinds: cancel discards the draft; the action is
					    the kind's own save — writing the endpoint, or signing in. */}
					<div className="flex shrink-0 items-center justify-end gap-2">
						<Button onClick={() => onDraftChange(null)} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						{draft.kind === "oauth" ? (
							<Button
								onClick={() => onLogin(draft.oauthProvider, loginOptionsOf(draft))}
								size="sm"
								variant="subtle"
								disabled={busy || loginInFlight}
							>
								{t("oauth.login")}
							</Button>
						) : (
							<Button
								onClick={onSave}
								size="sm"
								variant="subtle"
								disabled={busy || !isDraftComplete(draft)}
							>
								{t("common.save")}
							</Button>
						)}
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/**
 * The code a device-code sign-in waits on. Shown before anything opens, since
 * the page it is typed into asks for it straight away: the link copies the code
 * as it opens that page, so the user arrives with it on the clipboard.
 */
function DeviceCode({ code }: { code: { userCode: string; verificationUri: string } }) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const copy = () =>
		navigator.clipboard.writeText(code.userCode).then(
			() => setCopied(true),
			() => setCopied(false),
		);
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-[var(--color-background-elevated-secondary)] px-3 py-2">
			<div className="flex items-center gap-2">
				<span
					className="min-w-0 flex-1 select-all font-mono text-[length:var(--app-font-size-ui-lg,13px)] font-semibold tracking-[0.2em]"
					aria-label={t("oauth.deviceCode")}
				>
					{code.userCode}
				</span>
				<Button onClick={() => void copy()} size="icon-xs" variant="chrome-outline" title={t("oauth.copyCode")}>
					{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
				</Button>
			</div>
			<a
				href={code.verificationUri}
				target="_blank"
				rel="noreferrer"
				onClick={() => void copy()}
				className="flex items-center gap-1 self-start text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground underline-offset-2 hover:underline"
			>
				<ExternalLinkIcon className="size-3 shrink-0" />
				{t("oauth.copyAndOpen", { url: code.verificationUri.replace(/^https?:\/\//, "") })}
			</a>
		</div>
	);
}
