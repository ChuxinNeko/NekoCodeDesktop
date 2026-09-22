import { useEffect, useState } from "react";
import {
	formatKeyValueLines,
	parseKeyValueLines,
	splitCommand,
	type McpServerStatus,
	type McpSnapshot,
	type McpTransport,
	type SaveMcpServerRequest,
} from "../../../../shared/mcp";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { McpIcon, PlusIcon, RefreshCwIcon, TrashCanIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/** A draft in the editor, before it is a stored server. */
interface Draft {
	id?: string;
	name: string;
	transport: McpTransport;
	enabled: boolean;
	/** The whole command line, split on save — one field is what people paste. */
	command: string;
	url: string;
	/** `KEY=value` per line, for both env and headers. */
	pairs: string;
}

const BLANK: Draft = {
	name: "",
	transport: "stdio",
	enabled: true,
	command: "",
	url: "",
	pairs: "",
};

function draftOf(status: McpServerStatus): Draft {
	const { config } = status;
	return {
		id: config.id,
		name: config.name,
		transport: config.transport,
		enabled: config.enabled,
		command: [config.command ?? "", ...(config.args ?? [])].join(" ").trim(),
		url: config.url ?? "",
		pairs: formatKeyValueLines(config.transport === "stdio" ? config.env : config.headers),
	};
}

function toRequest(draft: Draft): SaveMcpServerRequest {
	const pairs = parseKeyValueLines(draft.pairs);
	if (draft.transport === "stdio") {
		const { command, args } = splitCommand(draft.command);
		return { id: draft.id, name: draft.name, transport: "stdio", enabled: draft.enabled, command, args, env: pairs };
	}
	return { id: draft.id, name: draft.name, transport: "http", enabled: draft.enabled, url: draft.url, headers: pairs };
}

const STATE_CLASS: Record<McpServerStatus["state"], string> = {
	ready: "bg-[var(--success,#16a34a)]",
	connecting: "bg-[var(--warning,#d97706)] animate-pulse",
	error: "bg-destructive",
	disabled: "bg-muted-foreground/40",
};

/**
 * Where MCP servers are added and watched.
 *
 * Connection state is pushed rather than polled: a stdio server can exit at any
 * moment, and a panel that only refreshed on open would keep showing a green
 * dot for a process that is gone.
 */
export function McpSettings() {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<McpSnapshot | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.mcpList().then(setSnapshot).catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);
	useEffect(() => api.onMcpChanged(setSnapshot), []);

	const run = (action: Promise<McpSnapshot>, after?: () => void) => {
		setBusy(true);
		setError(null);
		action
			.then((next) => {
				setSnapshot(next);
				after?.();
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const servers = snapshot?.servers ?? [];

	return (
		<section className="flex flex-col gap-3">
			<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{t("mcp.intro")}
			</p>

			{servers.length === 0 && !draft ? (
				<p className="rounded-lg border border-dashed border-[color:var(--app-surface-divider)] px-3 py-6 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
					{t("mcp.empty")}
				</p>
			) : null}

			<div className="flex flex-col gap-2">
				{servers.map((server) => (
					<div
						key={server.config.id}
						className="flex flex-col gap-1.5 rounded-lg border border-[color:var(--app-surface-divider)] px-3 py-2"
					>
						<div className="flex items-center gap-2">
							<span
								aria-hidden="true"
								className={cn("size-2 shrink-0 rounded-full", STATE_CLASS[server.state])}
							/>
							<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
								{server.config.name}
							</span>
							<span className="shrink-0 rounded bg-[var(--color-background-elevated-secondary)] px-1.5 py-0.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{server.config.transport}
							</span>
							<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{server.state === "ready"
									? t("mcp.toolCount", { count: server.tools.length })
									: (server.error ?? t(`mcp.state.${server.state}`))}
							</span>
							<Switch
								checked={server.config.enabled}
								disabled={busy}
								onCheckedChange={(checked: boolean) =>
									run(api.mcpSave({ ...toRequest(draftOf(server)), enabled: checked }))
								}
							/>
							<Button
								aria-label={t("mcp.reconnect")}
								disabled={busy || !server.config.enabled}
								onClick={() => run(api.mcpReconnect(server.config.id))}
								size="icon-xs"
								title={t("mcp.reconnect")}
								variant="ghost"
							>
								<RefreshCwIcon className="size-3.5" />
							</Button>
							<Button
								disabled={busy}
								onClick={() => setDraft(draftOf(server))}
								size="xs"
								variant="chrome-outline"
							>
								{t("common.edit")}
							</Button>
							<Button
								aria-label={t("common.delete")}
								disabled={busy}
								onClick={() => run(api.mcpRemove(server.config.id))}
								size="icon-xs"
								variant="ghost"
							>
								<TrashCanIcon className="size-3.5" />
							</Button>
						</div>
						{server.tools.length > 0 ? (
							<div className="flex flex-wrap gap-1 pl-4">
								{server.tools.map((tool) => (
									<span
										key={tool.qualifiedName}
										className="rounded bg-[var(--color-background-elevated-secondary)] px-1.5 py-0.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground"
										title={tool.description || tool.qualifiedName}
									>
										{tool.name}
									</span>
								))}
							</div>
						) : null}
					</div>
				))}
			</div>

			{draft ? (
				<div className="flex flex-col gap-2 rounded-lg border border-[color:var(--color-border-focus)] px-3 py-3">
					<Input
						placeholder={t("mcp.namePlaceholder")}
						value={draft.name}
						onChange={(event) => setDraft({ ...draft, name: event.target.value })}
					/>
					<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
						{(["stdio", "http"] as const).map((transport) => (
							<button
								key={transport}
								type="button"
								onClick={() => setDraft({ ...draft, transport })}
								className={cn(
									"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
									draft.transport === transport
										? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{transport}
							</button>
						))}
					</div>
					{draft.transport === "stdio" ? (
						<Input
							className="font-mono"
							placeholder={t("mcp.commandPlaceholder")}
							value={draft.command}
							onChange={(event) => setDraft({ ...draft, command: event.target.value })}
						/>
					) : (
						<Input
							className="font-mono"
							placeholder={t("mcp.urlPlaceholder")}
							value={draft.url}
							onChange={(event) => setDraft({ ...draft, url: event.target.value })}
						/>
					)}
					<textarea
						className="min-h-16 rounded-lg border border-[color:var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-[length:var(--app-font-size-ui-sm,11px)] outline-none placeholder:text-muted-foreground/50 focus:border-[color:var(--color-border-focus)]"
						placeholder={t(draft.transport === "stdio" ? "mcp.envPlaceholder" : "mcp.headersPlaceholder")}
						value={draft.pairs}
						onChange={(event) => setDraft({ ...draft, pairs: event.target.value })}
					/>
					<div className="flex items-center gap-2">
						<Button
							disabled={busy || !draft.name.trim()}
							onClick={() => run(api.mcpSave(toRequest(draft)), () => setDraft(null))}
							size="sm"
							variant="subtle"
						>
							{t("common.save")}
						</Button>
						<Button onClick={() => setDraft(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			) : (
				<Button className="self-start" onClick={() => setDraft({ ...BLANK })} size="sm" variant="chrome-outline">
					<PlusIcon className="size-3.5" />
					{t("mcp.add")}
				</Button>
			)}

			{error ? (
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span>
			) : null}

			<p className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
				<McpIcon className="size-3.5" />
				{t("mcp.footnote")}
			</p>
		</section>
	);
}
