import type { McpDesktopViewer, McpSnapshot } from "./mcp";
import type { SshHost } from "./ssh";

export interface McpDesktopCapability extends McpDesktopViewer {
	ticketEndpoint: string;
}

function httpUrl(value: unknown): URL | null {
	if (typeof value !== "string" || value.length > 4096 || /\s/.test(value)) return null;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search
			? url : null;
	} catch { return null; }
}

/** Trust only a same-origin extension bound to this exact configured MCP resource. */
export function parseDesktopViewerMetadata(serverUrl: string, value: unknown): Omit<McpDesktopCapability, "partition"> | null {
	if (!value || typeof value !== "object") return null;
	const metadata = value as Record<string, unknown>;
	const server = httpUrl(serverUrl);
	const resource = httpUrl(metadata.resource);
	const extension = metadata.desktop_viewer;
	if (!server || server.hash || !resource || resource.href !== server.href || !extension || typeof extension !== "object") return null;
	const fields = extension as Record<string, unknown>;
	const viewer = httpUrl(fields.viewer_url);
	const ticket = httpUrl(fields.ticket_endpoint);
	if (fields.read_only !== true || !viewer || !ticket || viewer.hash || ticket.hash ||
		viewer.origin !== server.origin || ticket.origin !== server.origin) return null;
	return { url: viewer.href, ticketEndpoint: ticket.href, readOnly: true };
}

/** No credentials in queries, extra fragments, or navigation to another page. */
export function isDesktopViewerUrl(viewer: McpDesktopViewer, value: string, requireTicket = false): boolean {
	const expected = httpUrl(viewer.url);
	const url = httpUrl(value);
	if (!expected || !url || expected.hash || url.origin !== expected.origin || url.pathname !== expected.pathname) return false;
	if (!url.hash) return !requireTicket;
	return /^#ticket=[A-Za-z0-9_-]{32,128}$/.test(url.hash);
}

export function parseDesktopTicket(viewer: McpDesktopViewer, value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const response = value as Record<string, unknown>;
	return response.read_only === true && typeof response.ticket_expires_in === "number" &&
		Number.isFinite(response.ticket_expires_in) && response.ticket_expires_in > 0 && response.ticket_expires_in <= 60 &&
		typeof response.viewer_url === "string" && isDesktopViewerUrl(viewer, response.viewer_url, true)
		? response.viewer_url : null;
}

export function isDesktopBridge(name: string | undefined, tools: readonly { name: string }[]): boolean {
	const names = new Set(tools.map(tool => tool.name));
	return name === "desktop-bridge" || ["session_status", "desktop_screenshot", "desktop_action", "browser_snapshot", "browser_action"].every(tool => names.has(tool));
}

export type DesktopSource =
	| { id: string; kind: "ssh"; name: string; hostId: string }
	| { id: string; kind: "mcp"; name: string; serverId: string; viewer: McpDesktopViewer };

export function desktopSources(hosts: readonly SshHost[], snapshot: McpSnapshot): DesktopSource[] {
	return [
		...hosts.map(host => ({ id: `ssh:${host.id}`, kind: "ssh" as const, name: host.name, hostId: host.id })),
		...snapshot.servers.flatMap(server => server.config.enabled && server.state === "ready" && server.desktopViewer
			? [{ id: `mcp:${server.config.id}`, kind: "mcp" as const, name: server.config.name, serverId: server.config.id, viewer: server.desktopViewer }]
			: []),
	];
}

export function selectDesktopSource(sources: readonly DesktopSource[], selected: string | null, activeHostId?: string): DesktopSource | null {
	return sources.find(source => source.id === selected) ??
		sources.find(source => source.kind === "ssh" && source.hostId === activeHostId) ?? sources[0] ?? null;
}
