import { describe, expect, test } from "bun:test";
import {
	desktopSources,
	isDesktopBridge,
	isDesktopViewerUrl,
	parseDesktopTicket,
	parseDesktopViewerMetadata,
	selectDesktopSource,
} from "../../src/shared/mcp-desktop";
import type { McpSnapshot } from "../../src/shared/mcp";
import type { SshHost } from "../../src/shared/ssh";

describe("shared/mcp-desktop", () => {
	test("identifies desktop-bridge by server name or full standard computer toolset", () => {
		expect(isDesktopBridge("desktop-bridge", [])).toBe(true);
		expect(
			isDesktopBridge("custom-agent", [
				{ name: "session_status" },
				{ name: "desktop_screenshot" },
				{ name: "desktop_action" },
				{ name: "browser_snapshot" },
				{ name: "browser_action" },
			]),
		).toBe(true);
		expect(
			isDesktopBridge("other", [
				{ name: "desktop_screenshot" },
				{ name: "desktop_action" },
			]),
		).toBe(false);
		expect(isDesktopBridge(undefined, [])).toBe(false);
	});

	test("parses and validates protected resource metadata strictly", () => {
		const valid = parseDesktopViewerMetadata("https://bridge.test:8443/mcp", {
			resource: "https://bridge.test:8443/mcp",
			desktop_viewer: {
				viewer_url: "https://bridge.test:8443/viewer",
				ticket_endpoint: "https://bridge.test:8443/api/viewer/ticket",
				read_only: true,
			},
		});
		expect(valid).toEqual({
			url: "https://bridge.test:8443/viewer",
			ticketEndpoint: "https://bridge.test:8443/api/viewer/ticket",
			readOnly: true,
		});

		// Must reject mismatched resource
		expect(
			parseDesktopViewerMetadata("https://bridge.test/mcp", {
				resource: "https://bridge.test/other",
				desktop_viewer: {
					viewer_url: "https://bridge.test/viewer",
					ticket_endpoint: "https://bridge.test/api/viewer/ticket",
					read_only: true,
				},
			}),
		).toBeNull();

		// Must reject cross-origin viewer or ticket
		expect(
			parseDesktopViewerMetadata("https://bridge.test/mcp", {
				resource: "https://bridge.test/mcp",
				desktop_viewer: {
					viewer_url: "https://evil.test/viewer",
					ticket_endpoint: "https://bridge.test/api/viewer/ticket",
					read_only: true,
				},
			}),
		).toBeNull();

		// Must reject userinfo or query in endpoints
		expect(
			parseDesktopViewerMetadata("https://bridge.test/mcp", {
				resource: "https://bridge.test/mcp",
				desktop_viewer: {
					viewer_url: "https://bridge.test/viewer?token=leak",
					ticket_endpoint: "https://bridge.test/api/viewer/ticket",
					read_only: true,
				},
			}),
		).toBeNull();

		// Must reject non read-only
		expect(
			parseDesktopViewerMetadata("https://bridge.test/mcp", {
				resource: "https://bridge.test/mcp",
				desktop_viewer: {
					viewer_url: "https://bridge.test/viewer",
					ticket_endpoint: "https://bridge.test/api/viewer/ticket",
					read_only: false,
				},
			}),
		).toBeNull();
	});

	test("validates desktop viewer URLs and tickets without leaking unexpected params", () => {
		const viewer = {
			url: "https://bridge.test/viewer",
			partition: "persist:test",
			readOnly: true as const,
		};

		expect(isDesktopViewerUrl(viewer, "https://bridge.test/viewer", false)).toBe(true);
		expect(isDesktopViewerUrl(viewer, "https://bridge.test/viewer", true)).toBe(false);
		expect(
			isDesktopViewerUrl(
				viewer,
				"https://bridge.test/viewer#ticket=Abc123_def456-Ghi7890123456789012",
				true,
			),
		).toBe(true);
		expect(
			isDesktopViewerUrl(
				viewer,
				"https://bridge.test/viewer#ticket=short",
				true,
			),
		).toBe(false);
		expect(isDesktopViewerUrl(viewer, "https://bridge.test/viewer?query=leak#ticket=123", true)).toBe(false);
		expect(isDesktopViewerUrl(viewer, "https://other.test/viewer", false)).toBe(false);

		const validTicket = parseDesktopTicket(viewer, {
			read_only: true,
			ticket_expires_in: 59,
			viewer_url: "https://bridge.test/viewer#ticket=Abc123_def456-Ghi7890123456789012",
		});
		expect(validTicket).toBe("https://bridge.test/viewer#ticket=Abc123_def456-Ghi7890123456789012");

		expect(
			parseDesktopTicket(viewer, {
				read_only: true,
				ticket_expires_in: 0,
				viewer_url: "https://bridge.test/viewer#ticket=Abc123_def456-Ghi7890123456789012",
			}),
		).toBeNull();
	});

	test("aggregates sources and maintains selection fallback across SSH and MCP", () => {
		const hosts: SshHost[] = [
			{
				id: "host-1",
				name: "Host 1",
				host: "1.1.1.1",
				port: 22,
				username: "root",
				auth: "key",
				privateKeyPath: null,
				remoteDir: null,
				fingerprint: null,
				hasSecret: false,
				vncPort: null,
				hasVncPassword: false,
			},
		];
		const snapshot: McpSnapshot = {
			servers: [
				{
					config: { id: "mcp-1", name: "Bridge", transport: "http", enabled: true, url: "https://b.test/mcp" },
					state: "ready",
					tools: [],
					desktopViewer: { url: "https://b.test/viewer", partition: "p1", readOnly: true },
				},
				{
					config: { id: "mcp-disabled", name: "Disabled", transport: "http", enabled: false },
					state: "disabled",
					tools: [],
					desktopViewer: { url: "https://d.test/viewer", partition: "p2", readOnly: true },
				},
				{
					config: { id: "mcp-error", name: "Error", transport: "http", enabled: true },
					state: "error",
					tools: [],
					desktopViewer: { url: "https://e.test/viewer", partition: "p3", readOnly: true },
				},
			],
		};

		const sources = desktopSources(hosts, snapshot);
		expect(sources.map((s: { id: string }) => s.id)).toEqual(["ssh:host-1", "mcp:mcp-1"]);

		// Fallback when active host is set
		expect(selectDesktopSource(sources, null, "host-1")?.id).toBe("ssh:host-1");
		// Selected source matches
		expect(selectDesktopSource(sources, "mcp:mcp-1", "host-1")?.id).toBe("mcp:mcp-1");
		// Fallback when selection is invalid
		expect(selectDesktopSource(sources, "deleted-source", undefined)?.id).toBe("ssh:host-1");
		// Works with only MCP (no SSH hosts)
		const mcpOnlySources = desktopSources([], snapshot);
		expect(mcpOnlySources.map((s: { id: string }) => s.id)).toEqual(["mcp:mcp-1"]);
		expect(selectDesktopSource(mcpOnlySources, null)?.id).toBe("mcp:mcp-1");
	});
});
