import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	MAX_MEMORIES_PER_SCOPE,
	MAX_MEMORY_TEXT,
	type MemoryEntry,
	type MemoryScope,
	type SaveMemoryRequest,
} from "../shared/memory";
import { projectKey, projectRoot } from "./project-root";

const FILE = "memory.json";

/**
 * How much memory goes into a system prompt. Past this the oldest entries are
 * left out rather than the prompt growing without bound — the settings page
 * still lists them, and saying so in the prompt tells the model to ask.
 */
const PROMPT_BUDGET = 12_000;

interface MemoryFile {
	version: 1;
	entries: MemoryEntry[];
}

function isEntry(value: unknown): value is MemoryEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<MemoryEntry>;
	return (
		typeof entry.id === "string" &&
		(entry.scope === "user" || entry.scope === "project") &&
		(entry.scope === "user" || typeof entry.project === "string") &&
		typeof entry.text === "string" &&
		typeof entry.createdAt === "number" &&
		typeof entry.updatedAt === "number"
	);
}

/**
 * Persistence for long-term memory, and the prompt section it becomes.
 *
 * One file for every scope: the entries are short and few, and a single file
 * is one thing to back up, inspect, or delete.
 */
export class MemoryStore {
	private readonly path: string;
	private entries: MemoryEntry[] | null = null;
	private listeners = new Set<() => void>();

	constructor(userDataDir: string) {
		mkdirSync(userDataDir, { recursive: true });
		this.path = join(userDataDir, FILE);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): MemoryEntry[] {
		if (this.entries) return this.entries;
		if (!existsSync(this.path)) return (this.entries = []);
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<MemoryFile>;
			this.entries = Array.isArray(parsed.entries)
				? parsed.entries.filter(isEntry).map((entry) => ({ ...entry, source: entry.source === "agent" ? "agent" : "user" }))
				: [];
		} catch (error) {
			throw new Error(
				`memory.json 已损坏，请修复或删除后重试：${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return this.entries;
	}

	/** The user's entries plus the ones for the project `cwd` is in. */
	forProject(cwd: string | undefined): MemoryEntry[] {
		const key = cwd ? projectKey(projectRoot(cwd)) : null;
		return this.list().filter(
			(entry) => entry.scope === "user" || (key !== null && entry.project !== undefined && projectKey(entry.project) === key),
		);
	}

	save(request: SaveMemoryRequest, source: MemoryEntry["source"]): MemoryEntry {
		const text = request.text.trim().replace(/\r\n/g, "\n");
		if (!text) throw new Error("记忆内容不能为空");
		if (text.length > MAX_MEMORY_TEXT) throw new Error(`单条记忆不能超过 ${MAX_MEMORY_TEXT} 字`);
		if (request.scope !== "user" && request.scope !== "project") throw new Error("未知的记忆范围");
		const entries = this.list();
		const existing = request.id ? entries.find((entry) => entry.id === request.id) : undefined;
		if (request.id && !existing) throw new Error("这条记忆已不存在");

		let project: string | undefined;
		if (request.scope === "project") {
			const cwd = request.cwd ?? existing?.project;
			if (!cwd) throw new Error("项目记忆需要指定项目目录");
			project = existing?.scope === "project" && !request.cwd ? existing.project : projectRoot(cwd);
		}

		if (!existing) {
			const peers = entries.filter(
				(entry) =>
					entry.scope === request.scope &&
					(request.scope === "user" || (entry.project && project && projectKey(entry.project) === projectKey(project))),
			);
			if (peers.length >= MAX_MEMORIES_PER_SCOPE) throw new Error("该范围内的记忆已达上限，请先清理旧条目");
			// The agent asked to remember something it already knows. Saying yes
			// again is harmless; a second copy in every prompt is not.
			const duplicate = peers.find((entry) => entry.text === text);
			if (duplicate) return duplicate;
		}

		const now = Date.now();
		const entry: MemoryEntry = {
			id: existing?.id ?? randomUUID(),
			scope: request.scope,
			...(project ? { project } : {}),
			text,
			source: existing?.source ?? source,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		this.entries = existing ? entries.map((item) => (item.id === entry.id ? entry : item)) : [...entries, entry];
		this.write();
		return entry;
	}

	remove(id: string): boolean {
		const entries = this.list();
		const next = entries.filter((entry) => entry.id !== id);
		if (next.length === entries.length) return false;
		this.entries = next;
		this.write();
		return true;
	}

	/**
	 * The system-prompt section for a session in `cwd`, or "" when there is
	 * nothing to remember. Ids are included so the model can name an entry to
	 * forget without quoting it back.
	 */
	promptSection(cwd: string | undefined): string {
		const entries = this.forProject(cwd);
		if (entries.length === 0) return "";
		const render = (scope: MemoryScope, title: string): string[] => {
			const lines = entries
				.filter((entry) => entry.scope === scope)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((entry) => `- [${entry.id.slice(0, 8)}] ${entry.text.replace(/\n+/g, " ")}`);
			return lines.length ? [`### ${title}`, ...lines] : [];
		};
		const all = [...render("user", "用户偏好（所有项目）"), ...render("project", "本项目约定")];
		const kept: string[] = [];
		let size = 0;
		let dropped = 0;
		for (const line of all) {
			if (size + line.length > PROMPT_BUDGET && !line.startsWith("###")) {
				dropped++;
				continue;
			}
			kept.push(line);
			size += line.length + 1;
		}
		return [
			"## 长期记忆（用户确认过的跨会话信息，不是新的操作授权）",
			"以下是此前会话记下的偏好与约定。与当前用户的明确指示冲突时以当前指示为准；发现过时或错误时用 memory 工具更新或删除。",
			...kept,
			dropped ? `（另有 ${dropped} 条较早的记忆因篇幅未列出）` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	private write(): void {
		const file: MemoryFile = { version: 1, entries: this.list() };
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
		renameSync(temporary, this.path);
		for (const listener of this.listeners) listener();
	}
}
