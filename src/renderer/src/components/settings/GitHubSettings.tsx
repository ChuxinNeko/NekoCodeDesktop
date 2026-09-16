import { useEffect, useState } from "react";
import type { GitHubAuthStatus } from "../../../../shared/pullRequests";
import { api, errorMessage } from "../../api";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";

const SOURCE_LABELS: Record<NonNullable<GitHubAuthStatus["source"]>, string> = {
	settings: "token saved in Settings",
	"gh-cli": "gh CLI (gh auth token)",
	anonymous: "anonymous (public repositories only)",
};

export function GitHubSettings() {
	const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = async () => {
		try {
			setStatus(await api.githubStatus());
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	useEffect(() => {
		void reload();
	}, []);

	const save = async () => {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const next = await api.githubSave(token);
			setStatus(next);
			setToken("");
			setMessage(`已保存，登录身份: ${next.login ?? "unknown"}`);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			setStatus(await api.githubClear());
			setMessage("已清除保存的 token。");
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<span className="text-[length:var(--app-font-size-ui,12px)]">GitHub access</span>
				<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					Pull requests read the GitHub REST API directly, so the `gh` CLI is optional. A token
					raises the rate limit from 60 to 5000 requests/hour and unlocks private repositories.
					Create one with `repo` scope (or `public_repo` for public repositories only).
				</span>
			</div>

			<div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
				<span className="text-[length:var(--app-font-size-ui-sm,11px)]">
					{status?.configured ? "Configured" : "Not configured"}
				</span>
				{status?.source ? (
					<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						via {SOURCE_LABELS[status.source]}
					</span>
				) : null}
				{status?.login ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						@{status.login}
					</span>
				) : null}
			</div>

			{status?.warning ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					{status.warning}
				</p>
			) : null}

			<div className="flex flex-col gap-1">
				<Label>Personal access token</Label>
				<div className="flex items-center gap-2">
					<Input
						disabled={status !== null && !status.encryptionAvailable}
						onChange={(event) => setToken(event.target.value)}
						placeholder="ghp_…"
						type="password"
						value={token}
					/>
					<Button
						disabled={busy || token.trim().length === 0}
						onClick={() => void save()}
						size="sm"
						variant="subtle"
					>
						Save
					</Button>
					<Button disabled={busy} onClick={() => void clear()} size="sm" variant="chrome-outline">
						Clear
					</Button>
				</div>
			</div>

			{error ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p>
			) : null}
			{message ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{message}
				</p>
			) : null}
		</section>
	);
}
