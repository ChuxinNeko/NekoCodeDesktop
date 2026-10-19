import { useEffect, useRef, useState } from "react";
import type { GitHubProfile, GitHubRepository } from "../../../../shared/github-profile";
import type { GitHubAuthStatus } from "../../../../shared/pullRequests";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { ExternalLinkIcon, GitHubIcon, RefreshCwIcon, StarIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { GitHubConnectDialog } from "./GitHubConnectDialog";

const INSTALL_URL = /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/;

/**
 * GitHub for the rest of the app: pull requests, issues, and repository tools.
 *
 * An empty page is one card and a connect button. The authorization method is a
 * dialog, because it is chosen once. Afterwards the page is the account and the
 * repositories that account can see.
 */
export function GitHubSettings({ onStatusChange }: { onStatusChange?: (status: GitHubAuthStatus) => void } = {}) {
	const { t, language } = useTranslation();
	const desktop = api.runtime === "electron";
	const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
	const [profile, setProfile] = useState<GitHubProfile | null>(null);
	const [profileLoading, setProfileLoading] = useState(false);
	const [profileError, setProfileError] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const profileRequest = useRef(0);
	useEffect(() => { if (status) onStatusChange?.(status); }, [status, onStatusChange]);

	const loadProfile = () => {
		const request = ++profileRequest.current;
		setProfileLoading(true);
		setProfileError(null);
		return api
			.githubProfile()
			.then((next) => {
				if (profileRequest.current === request) setProfile(next);
			})
			.catch((cause: unknown) => {
				if (profileRequest.current !== request) return;
				setProfile(null);
				setProfileError(errorMessage(cause));
			})
			.finally(() => {
				if (profileRequest.current === request) setProfileLoading(false);
			});
	};

	useEffect(() => {
		let alive = true;
		void api
			.githubStatus()
			.then((value) => {
				if (!alive) return;
				setStatus(value);
				if (value.configured) void loadProfile();
			})
			.catch((cause: unknown) => {
				if (alive) setError(errorMessage(cause));
			});
		return () => {
			alive = false;
			profileRequest.current++;
		};
	}, []);

	const disconnect = () => {
		setBusy(true);
		setError(null);
		void api
			.githubClear()
			.then((next) => {
				profileRequest.current++;
				setStatus(next);
				setProfile(null);
				setProfileError(null);
				if (next.configured) void loadProfile();
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const connected = (next: GitHubAuthStatus) => {
		setStatus(next);
		setConnecting(false);
		if (next.configured) void loadProfile();
	};

	const cannotStore = status !== null && !status.encryptionAvailable;
	const explicit = status?.source === "oauth" || status?.source === "settings";
	const installationUrl = status?.installationUrl && INSTALL_URL.test(status.installationUrl) ? status.installationUrl : null;

	return (
		<section className="flex flex-col gap-4">
			{status?.warning ? (
				<p className="rounded-xl bg-[var(--warning)]/10 px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					{status.warning}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</p>
			) : null}

			{!status && !error ? (
				<div className="flex min-h-56 items-center justify-center rounded-2xl border border-[color:var(--app-surface-divider)]">
					<Spinner className="size-4" />
				</div>
			) : null}

			{status && !status.configured ? (
				<EmptyCard
					disabled={cannotStore}
					hint={t("github.emptyHint")}
					onConnect={() => setConnecting(true)}
					title={t("github.notConfigured")}
				/>
			) : null}

			{status?.configured ? (
				<AccountPanel
					busy={busy}
					canDisconnect={explicit}
					connectDisabled={cannotStore}
					onConnect={() => setConnecting(true)}
					installationUrl={installationUrl}
					language={language}
					loading={profileLoading}
					onDisconnect={disconnect}
					onOpen={(url) => void api.openExternal(url).catch((cause: unknown) => setError(errorMessage(cause)))}
					onRetry={() => void loadProfile()}
					profile={profile}
					profileError={profileError}
					source={sourceLabel(status, t)}
					status={status}
				/>
			) : null}

			{connecting ? (
				<GitHubConnectDialog
					cannotStore={cannotStore}
					desktop={desktop}
					onClose={() => setConnecting(false)}
					onConnected={connected}
				/>
			) : null}
		</section>
	);
}

function sourceLabel(status: GitHubAuthStatus, t: ReturnType<typeof useTranslation>["t"]): string | null {
	switch (status.source) {
		case "settings":
			return t("github.source.settings");
		case "oauth":
			return t(status.authorizationMethod === "device" ? "github.method.device" : "github.method.browser");
		case "gh-cli":
			return t("github.source.ghCli");
		case "anonymous":
			return t("github.source.anonymous");
		default:
			return null;
	}
}

function EmptyCard({
	title,
	hint,
	disabled,
	onConnect,
}: {
	title: string;
	hint: string;
	disabled: boolean;
	onConnect: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex min-h-[22rem] flex-col rounded-2xl border border-[color:var(--app-surface-divider)] bg-muted/25">
			<div className="p-4">
				<Button disabled={disabled} onClick={onConnect} size="sm">
					<GitHubIcon className="size-3.5" />
					{t("github.connect")}
				</Button>
			</div>
			<div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 pb-16 text-center">
				<span className="flex size-16 items-center justify-center rounded-2xl border border-[color:var(--app-surface-divider)] bg-background">
					<GitHubIcon className="size-7" />
				</span>
				<div className="flex max-w-sm flex-col gap-1.5">
					<p className="text-base font-medium">{title}</p>
					<p className="text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">{hint}</p>
				</div>
			</div>
		</div>
	);
}

function AccountPanel({
	status,
	profile,
	loading,
	profileError,
	source,
	busy,
	canDisconnect,
	connectDisabled,
	onConnect,
	installationUrl,
	language,
	onDisconnect,
	onRetry,
	onOpen,
}: {
	status: GitHubAuthStatus;
	profile: GitHubProfile | null;
	loading: boolean;
	profileError: string | null;
	source: string | null;
	busy: boolean;
	canDisconnect: boolean;
	connectDisabled: boolean;
	onConnect: () => void;
	installationUrl: string | null;
	language: string;
	onDisconnect: () => void;
	onRetry: () => void;
	onOpen: (url: string) => void;
}) {
	const { t } = useTranslation();
	const account = profile?.account;
	const login = account?.login ?? status.login;

	return (
		<div className="flex flex-col gap-4">
			<article className="rounded-2xl border border-[color:var(--app-surface-divider)] p-4">
				<div className="flex items-start gap-4">
					{account?.avatarUrl ? (
						<img
							alt=""
							className="size-14 shrink-0 rounded-full border border-[color:var(--app-surface-divider)] object-cover"
							src={account.avatarUrl}
						/>
					) : (
						<span className="flex size-14 shrink-0 items-center justify-center rounded-full border border-[color:var(--app-surface-divider)] bg-muted/40">
							<GitHubIcon className="size-6" />
						</span>
					)}
					<div className="min-w-0 flex-1">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<h3 className="truncate text-base font-semibold">{account?.name || login || "GitHub"}</h3>
								{login && account ? (
									<button
										type="button"
										className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground hover:underline"
										onClick={() => onOpen(account.htmlUrl)}
									>
										@{login}
									</button>
								) : login ? (
									<p className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">@{login}</p>
								) : null}
							</div>
							<div className="flex shrink-0 flex-wrap justify-end gap-1.5">
								{installationUrl ? (
									<Button disabled={busy} onClick={() => onOpen(installationUrl)} size="sm" variant="chrome-outline">
										{t("github.manageRepositories")}
									</Button>
								) : null}
								{canDisconnect ? (
									<Button disabled={busy} onClick={onDisconnect} size="sm" variant="ghost">
										{t("github.disconnect")}
									</Button>
								) : (
									<Button disabled={busy || connectDisabled} onClick={onConnect} size="sm">
										<GitHubIcon className="size-3.5" />
										{t("github.connect")}
									</Button>
								)}
							</div>
						</div>
						{account?.bio ? (
							<p className="mt-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">{account.bio}</p>
						) : null}
						{account ? (
							<p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--app-font-size-ui-sm,11px)]">
								<span>{t("github.statRepos", { count: account.publicRepos })}</span>
								<span>{t("github.statFollowers", { count: account.followers })}</span>
								<span>{t("github.statFollowing", { count: account.following })}</span>
							</p>
						) : null}
						{account && (account.company || account.location) ? (
							<p className="mt-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{[account.company, account.location].filter(Boolean).join(" · ")}
							</p>
						) : null}
						{source ? (
							<p className="mt-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("github.via", { source })}</p>
						) : null}
						{installationUrl ? (
							<p className="mt-1 text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">{t("github.repositoryAccessHint")}</p>
						) : null}
					</div>
				</div>
				{loading && !account ? (
					<p className="mt-4 flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						<Spinner className="size-3.5" />
						{t("github.loadingAccount")}
					</p>
				) : null}
				{profileError ? (
					<div className="mt-4 flex flex-wrap items-center gap-2">
						<p role="alert" className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
							{profileError}
						</p>
						<Button onClick={onRetry} size="sm" variant="chrome-outline">
							{t("github.retry")}
						</Button>
					</div>
				) : null}
			</article>

			{account ? (
				<section className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2">
						<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
							{t("github.repositories")}
							<span className="ml-2 font-normal text-muted-foreground">{profile?.repositories.length ?? 0}</span>
						</h3>
						<Button aria-label={t("github.refresh")} disabled={loading} onClick={onRetry} size="icon-xs" variant="ghost">
							<RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
						</Button>
					</div>
					{profile?.repositoriesWarning ? (
						<p className="rounded-xl bg-[var(--warning)]/10 px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
							{profile.repositoriesWarning}
						</p>
					) : null}
					{profile && profile.repositories.length === 0 && !profile.repositoriesWarning ? (
						<p className="rounded-xl border border-dashed border-[color:var(--app-surface-divider)] px-3 py-8 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{t("github.repositoriesEmpty")}
						</p>
					) : null}
					<ul className="flex flex-col gap-1.5">
						{profile?.repositories.map((repo) => (
							<RepositoryRow key={repo.fullName} language={language} onOpen={onOpen} repo={repo} />
						))}
					</ul>
					{profile?.truncated ? (
						<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("github.repositoriesTruncated")}</p>
					) : null}
				</section>
			) : null}
		</div>
	);
}

function RepositoryRow({
	repo,
	language,
	onOpen,
}: {
	repo: GitHubRepository;
	language: string;
	onOpen: (url: string) => void;
}) {
	const { t } = useTranslation();
	const updated = repo.updatedAt ? new Date(repo.updatedAt) : null;
	const updatedLabel = updated && !Number.isNaN(updated.getTime()) ? updated.toLocaleDateString(language) : null;
	return (
		<li>
			<button
				type="button"
				onClick={() => onOpen(repo.htmlUrl)}
				className="flex w-full items-start gap-3 rounded-xl border border-[color:var(--app-surface-divider)] px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
			>
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-center gap-2">
						<span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">{repo.fullName}</span>
						<span className="rounded-full border border-border px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{repo.private ? t("github.repoPrivate") : t("github.repoPublic")}
						</span>
						{repo.fork ? (
							<span className="rounded-full border border-border px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{t("github.repoFork")}
							</span>
						) : null}
					</span>
					{repo.description ? (
						<span className="mt-1 block truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{repo.description}</span>
					) : null}
					<span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{repo.language ? <span>{repo.language}</span> : null}
						<span className="inline-flex items-center gap-1">
							<StarIcon className="size-3" />
							{repo.stars}
						</span>
						{updatedLabel ? <span>{t("github.updatedOn", { date: updatedLabel })}</span> : null}
					</span>
				</span>
				<ExternalLinkIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
			</button>
		</li>
	);
}
