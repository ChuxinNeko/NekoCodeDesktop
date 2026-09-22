import type { WebUiEventChannel, WebUiRpcMethod, WebUiRuntime } from "../../shared/webui";
import { isWebUiRpcMethod } from "../../shared/webui";
import type { AgentApi } from "./api";

const SUBSCRIPTIONS = {
	onRelayChanged: "relay:changed",
	onBrowserPopup: "browser:popup",
	onBrowserPreview: "browser:preview",
	onBrowserElementSelected: "browser:elementSelected",
	onBrowserInspectStopped: "browser:inspectStopped",
	onSessionsChanged: "agent:sessionsChanged",
	onRevealSession: "agent:revealSession",
	onMcpChanged: "mcp:changed",
	onQqBotChanged: "qqbot:changed",
	onAgentDefaults: "agent:defaults",
	onAgentSnapshot: "agent:snapshot",
	onPluginsChanged: "plugins:changed",
	onTerminalData: "terminal:data",
	onTerminalExit: "terminal:exit",
	onOAuthEvent: "oauth:event",
	onAutomationEvent: "automation:event",
} as const satisfies Record<string, WebUiEventChannel>;

export function createWebUiApi(runtime: WebUiRuntime): AgentApi {
	const basePath = runtime.basePath;
	let events: EventSource | null = null;
	const listeners = new Map<WebUiEventChannel, Set<(payload: never) => void>>();

	const rpc = async (method: WebUiRpcMethod, args: unknown[]): Promise<unknown> => {
		const response = await fetch(`${basePath}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, args }),
		});
		if (response.status === 401) {
			location.assign(`${basePath}/login`);
			throw new Error("未登录");
		}
		if (!response.ok) throw new Error(`WebUI request failed: ${response.status}`);
		const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
		if (!body.ok) throw new Error(body.error ?? "WebUI request failed");
		return body.result;
	};

	const ensureEvents = (): EventSource => {
		if (events) return events;
		events = new EventSource(`${basePath}/api/events`);
		events.onmessage = (message) => {
			let envelope: { channel?: unknown; payload?: unknown };
			try {
				envelope = JSON.parse(message.data as string) as typeof envelope;
			} catch {
				return;
			}
			const channel = envelope.channel as WebUiEventChannel;
			const targets = listeners.get(channel);
			if (!targets) return;
			for (const listener of targets) listener(envelope.payload as never);
		};
		events.onerror = () => {};
		return events;
	};

	const subscribe = (channel: WebUiEventChannel, listener: (payload: never) => void) => {
		ensureEvents();
		let set = listeners.get(channel);
		if (!set) listeners.set(channel, (set = new Set()));
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) listeners.delete(channel);
		};
	};

	const unsupported = (message: string) => () => Promise.reject(new Error(message));

	const base: Record<string, unknown> = {
		runtime: "web",
		shell: runtime.shell,
		windowMaterial: runtime.shell.material,
		homeDir: runtime.homeDir,
		openExternal: (url: string) => {
			window.open(url, "_blank", "noopener,noreferrer");
			return Promise.resolve();
		},
		setTheme: () => Promise.resolve(),
		setWindowMaterial: () => Promise.resolve(runtime.shell),
		browserSetInspect: unsupported("WebUI 中不支持内置浏览器"),
		browserBindAutomation: unsupported("WebUI 中不支持内置浏览器"),
		pickDirectory: unsupported("WebUI 请使用宿主目录选择器"),
		lanAddProject: unsupported("WebUI 请使用宿主目录选择器"),
		qqBotChooseProject: unsupported("WebUI 请使用宿主目录选择器"),
		webUiStatus: unsupported("请在桌面应用中配置 WebUI"),
		webUiSave: unsupported("请在桌面应用中配置 WebUI"),
	};
	for (const [method, channel] of Object.entries(SUBSCRIPTIONS)) {
		base[method] = (listener: (payload: never) => void) => subscribe(channel, listener);
	}

	return new Proxy(base, {
		get(target, prop) {
			if (typeof prop !== "string") return undefined;
			if (prop in target) return target[prop];
			if (isWebUiRpcMethod(prop)) {
				return (...args: unknown[]) => rpc(prop, args);
			}
			return undefined;
		},
	}) as unknown as AgentApi;
}
