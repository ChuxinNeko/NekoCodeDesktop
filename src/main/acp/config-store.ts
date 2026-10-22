/**
 * The external agents a user has set up, kept across restarts.
 *
 * Built-in agents are code; only what the user changed about them is stored —
 * switched off, a different command, extra environment — so an update that
 * bumps an adapter version still reaches everyone who never touched it.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AcpModelSettings, AcpProviderState, AcpSaveAgentRequest } from "../../shared/acp";
import { validateAcpProviderState } from "./providers";
import { validateAcpModelSettings } from "./model-settings";
import { BUILTIN_ACP_AGENTS, type AcpAgentDefinition } from "./agents";
import type { AcpNativeConfig } from "./native-config";

interface StoredOverride {
	modelSettings?: AcpModelSettings;
	providerState?: AcpProviderState;
	id: string;
	name?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	enabled?: boolean;
}

interface StoredCustom {
	modelSettings?: AcpModelSettings;
	providerState?: AcpProviderState;
	id: string;
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	enabled: boolean;
}

interface StoredFile {
	builtins: StoredOverride[];
	custom: StoredCustom[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isObject(value)) return undefined;
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function storedModelSettings(id: string, raw: unknown): AcpModelSettings | undefined {
	if (raw === undefined) return undefined;
	try { return validateAcpModelSettings(id, raw); } catch { return undefined; }
}

function storedProviderState(id: string, raw: unknown): AcpProviderState | undefined {
	if (raw === undefined) return undefined;
	try { return validateAcpProviderState(id, raw); } catch { return undefined; }
}

function parse(raw: unknown): StoredFile {
	const file: StoredFile = { builtins: [], custom: [] };
	if (!isObject(raw)) return file;
	for (const entry of Array.isArray(raw.builtins) ? raw.builtins : []) {
		if (!isObject(entry) || typeof entry.id !== "string") continue;
		file.builtins.push({
			id: entry.id,
			...(storedProviderState(entry.id, entry.providerState) ? { providerState: storedProviderState(entry.id, entry.providerState) } : {}),
			...(storedModelSettings(entry.id, entry.modelSettings) ? { modelSettings: storedModelSettings(entry.id, entry.modelSettings) } : {}),
			...(typeof entry.name === "string" ? { name: entry.name } : {}),
			...(typeof entry.command === "string" ? { command: entry.command } : {}),
			...(stringArray(entry.args) ? { args: stringArray(entry.args) } : {}),
			...(stringRecord(entry.env) ? { env: stringRecord(entry.env) } : {}),
			...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
		});
	}
	for (const entry of Array.isArray(raw.custom) ? raw.custom : []) {
		if (!isObject(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.command !== "string") continue;
		file.custom.push({
			id: entry.id,
			...(storedProviderState(entry.id, entry.providerState) ? { providerState: storedProviderState(entry.id, entry.providerState) } : {}),
			...(storedModelSettings(entry.id, entry.modelSettings) ? { modelSettings: storedModelSettings(entry.id, entry.modelSettings) } : {}),
			name: entry.name,
			command: entry.command,
			args: stringArray(entry.args) ?? [],
			env: stringRecord(entry.env) ?? {},
			enabled: entry.enabled !== false,
		});
	}
	return file;
}

export class AcpConfigStore {
	private readonly filePath: string;
	private file: StoredFile | null = null;

	constructor(private readonly userDataDir: string, private readonly nativeConfig?: AcpNativeConfig) {
		this.filePath = join(userDataDir, "acp-agents.json");
	}

	private load(): StoredFile {
		if (this.file) return this.file;
		try {
			this.file = existsSync(this.filePath) ? parse(JSON.parse(readFileSync(this.filePath, "utf8"))) : parse(null);
		} catch {
			// A damaged file costs the customizations, not the app.
			this.file = parse(null);
		}
		return this.file;
	}

	private persist(next: StoredFile): void {
		mkdirSync(this.userDataDir, { recursive: true });
		const tmp = `${this.filePath}.tmp-${process.pid}`;
		try {
			// Env values are often API keys: readable by the user only.
			writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
		this.file = next;
	}

	list(): AcpAgentDefinition[] {
		const file = this.load();
		const builtins = BUILTIN_ACP_AGENTS.map((agent) => {
			const override = file.builtins.find((entry) => entry.id === agent.id);
			return override ? { ...agent, ...override, builtin: true } : agent;
		});
		const custom = file.custom.map((entry) => ({ ...entry, description: "自定义 ACP 代理", builtin: false }));
		return [...builtins, ...custom].map((agent) => {
			if (!this.nativeConfig) return agent;
			if (agent.providerState) {
				if (!agent.providerState.profiles.some((profile) => profile.category === "current" && !profile.config.trim())) return agent;
				const imported = this.nativeConfig.importCurrent(agent)?.profiles[0];
				if (!imported) return agent;
				return { ...agent, providerState: { ...agent.providerState, profiles: agent.providerState.profiles.map((profile) => profile.category === "current" && !profile.config.trim() ? { ...profile, config: imported.config, apiKey: imported.apiKey } : profile) } };
			}
			if (agent.modelSettings && agent.modelSettings.mode !== "inherit") return agent;
			const providerState = this.nativeConfig.importCurrent(agent);
			return providerState ? { ...agent, providerState } : agent;
		});
	}

	find(id: string): AcpAgentDefinition | undefined {
		return this.list().find((agent) => agent.id === id);
	}

	/** Also migrate saved selections made before native-file synchronization existed. */
	syncNative(id: string): void {
		const agent = this.find(id);
		if (!agent || !this.nativeConfig) return;
		const stored = this.load().builtins.find((entry) => entry.id === id);
		// Capture the original configuration before applying an older release's
		// already-selected provider, so the imported card can still restore it.
		if (agent.providerState && !isDeepStrictEqual(stored?.providerState, agent.providerState)) this.save(agent);
		this.nativeConfig.apply(agent);
	}

	save(request: AcpSaveAgentRequest): AcpAgentDefinition {
		const name = request.name.trim();
		const command = request.command.trim();
		const builtin = BUILTIN_ACP_AGENTS.find((agent) => agent.id === request.id);
		const previous = request.id ? this.find(request.id) : undefined;
		if (!name) throw new Error("请填写代理名称");
		// A built-in agent without a command runs its bundled adapter or its own CLI.
		if (!command && !builtin?.bundled && !builtin?.native) throw new Error("请填写启动命令");
		const file = this.load();
		const modelSettings = request.modelSettings === undefined ? this.find(request.id ?? "")?.modelSettings : validateAcpModelSettings(request.id ?? "", request.modelSettings);
		const providerState = request.providerState === undefined ? this.find(request.id ?? "")?.providerState : validateAcpProviderState(request.id ?? "", request.providerState);
		const fields = { ...(providerState ? { providerState } : {}), ...(modelSettings ? { modelSettings } : {}), name, command, args: command ? [...request.args] : [], env: { ...request.env }, enabled: request.enabled };
		if (builtin) {
			const rollback = this.nativeConfig?.apply({ ...builtin, ...fields }, previous);
			try { this.persist({
				...file,
				builtins: [...file.builtins.filter((entry) => entry.id !== builtin.id), { id: builtin.id, ...fields }],
			}); } catch (error) { rollback?.(); throw error; }
		} else {
			const id = request.id && file.custom.some((entry) => entry.id === request.id) ? request.id : `custom-${randomUUID()}`;
			this.persist({ ...file, custom: [...file.custom.filter((entry) => entry.id !== id), { id, ...fields }] });
			return this.find(id)!;
		}
		return this.find(builtin.id)!;
	}

	/** Custom agents are deleted; a built-in one goes back to how it shipped. */
	remove(id: string): void {
		const file = this.load();
		this.persist({
			builtins: file.builtins.filter((entry) => entry.id !== id),
			custom: file.custom.filter((entry) => entry.id !== id),
		});
	}
}
