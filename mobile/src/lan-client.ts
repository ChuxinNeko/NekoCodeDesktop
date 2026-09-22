import { normalizeDesktopAddress } from "../../src/shared/lan-pairing";
export { normalizeDesktopAddress } from "../../src/shared/lan-pairing";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import type { AgentDefaults, AgentSnapshot, SendPromptResult } from "../../src/shared/agent";
import type { AgentSnapshotDelta } from "../../src/shared/agent-delta";
import type { DeltaRequest, ToolOutputChunk } from "./desktop-client";
import type { LanState, LanTaskOptions } from "../../src/shared/lan";
import type { WorkflowAnswer } from "../../src/shared/workflow";
import type { SlashCommandSummary } from "../../src/shared/commands";

export interface Binding { endpoint: string; token: string; name: string }
export interface SubmitResult { id: string; accepted: boolean; error?: string }
export class LanError extends Error { constructor(message: string, readonly status?: number) { super(message); } }

export class LanClient {
	binding: Binding | null = null;
	async restore(): Promise<Binding | null> {
		try {
			const saved = JSON.parse((await Preferences.get({ key: "desktop-binding" })).value ?? "null");
			if (saved && typeof saved.token === "string" && /^[a-f0-9]{64}$/.test(saved.token)) {
				this.binding = { endpoint: normalizeDesktopAddress(saved.endpoint), token: saved.token, name: saved.name ?? "NekoCode Desktop" };
			}
		} catch { this.binding = null; }
		return this.binding;
	}

	private async request<T>(path: string, data?: unknown, binding = this.binding): Promise<T> {
		if (!binding) throw new LanError("请先绑定电脑", 401);
		const headers = { ...(binding.token ? { Authorization: `Bearer ${binding.token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) };
		let status: number;
		let body: unknown;
		if (Capacitor.isNativePlatform()) {
			const response = await CapacitorHttp.request({
				url: binding.endpoint + path, method: data === undefined ? "GET" : "POST", headers, data,
				connectTimeout: 7000, readTimeout: 20_000, responseType: "json", disableRedirects: true,
			});
			status = response.status; body = response.data;
		} else {
			// Development proxy only. The APK always uses the native HTTP transport.
			if (!import.meta.env.DEV) throw new Error("请在 手机 APP 中连接电脑");
			const response = await fetch("/desktop" + path, { method: data === undefined ? "GET" : "POST", headers, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20_000), redirect: "error" });
			status = response.status; body = await response.json();
		}
		if (status < 200 || status >= 300) throw new LanError((body as { error?: string })?.error ?? "连接失败", status);
		return body as T;
	}

	async pair(endpoint: string, code: string, name: string): Promise<void> {
		const connection = { endpoint: normalizeDesktopAddress(endpoint), token: "", name: "NekoCode Desktop" };
		const info = await this.request<{ name: string; protocol: number }>("/api/info", undefined, connection);
		if (info.protocol !== 1) throw new Error("电脑与手机版本不兼容，请更新应用");
		const response = await this.request<{ token: string }>("/api/pair", { code, name }, connection);
		this.binding = { ...connection, token: response.token, name: info.name };
		await Preferences.set({ key: "desktop-binding", value: JSON.stringify(this.binding) });
		await Preferences.remove({ key: "pending-message" });
	}

	async disconnect(): Promise<void> {
		this.binding = null;
		await Preferences.remove({ key: "desktop-binding" });
		await Preferences.remove({ key: "pending-message" });
	}

	private async submit<T>(path: string, payload: Record<string, unknown>): Promise<T> {
		let saved: { path: string; payload: Record<string, unknown>; requestId: string } | null = null;
		try { saved = JSON.parse((await Preferences.get({ key: "pending-message" })).value ?? "null"); } catch { /* discard corrupt draft */ }
		const submission = saved?.path === path && JSON.stringify(saved.payload) === JSON.stringify(payload)
			? saved : { path, payload, requestId: crypto.randomUUID() };
		await Preferences.set({ key: "pending-message", value: JSON.stringify(submission) });
		const result = await this.request<T>(path, { ...payload, requestId: submission.requestId });
		await Preferences.remove({ key: "pending-message" });
		return result;
	}

	state() { return this.request<LanState>("/api/state"); }
	defaults(projectId: string) { return this.request<AgentDefaults>(`/api/projects/${encodeURIComponent(projectId)}/defaults`); }
	snapshot(id: string) { return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}`); }
	delta(id: string, options: DeltaRequest = {}) { return this.request<AgentSnapshotDelta>(`/api/tasks/${encodeURIComponent(id)}/delta`, options); }
	toolOutput(id: string, toolCallId: string, offset: number) { return this.request<ToolOutputChunk>(`/api/tasks/${encodeURIComponent(id)}/tool-output`, { toolCallId, offset }); }
	create(projectId: string, text: string, options: LanTaskOptions) { return this.submit<SubmitResult>("/api/tasks", { projectId, text, options }); }
	send(id: string, text: string) { return this.submit<SendPromptResult>(`/api/tasks/${encodeURIComponent(id)}/send`, { text }); }
	configure(id: string, options: LanTaskOptions) { return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/configure`, options); }
	abort(id: string) { return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/abort`, {}); }
	answer(id: string, answer: WorkflowAnswer) { return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/answer`, answer); }
	cancelWorker(id: string, workerId: string) { return this.request<AgentSnapshot>(`/api/tasks/${encodeURIComponent(id)}/cancel-worker`, { id: workerId }); }
	commands(id: string) { return this.request<SlashCommandSummary[]>(`/api/tasks/${encodeURIComponent(id)}/commands`); }
}

export const lan = new LanClient();
