import { app } from "electron";
import { HookService } from "./hooks";
import { MemoryStore } from "./memory-store";

/**
 * The app-wide memory and hook stores.
 *
 * One of each for the whole process, not one per session: every session —
 * foreground, background, automation — has to see the same memories and obey
 * the same hooks, and an edit in settings has to reach all of them at once.
 */
let memory: MemoryStore | null = null;
let hooks: HookService | null = null;

export function memoryStore(): MemoryStore {
	memory ??= new MemoryStore(app.getPath("userData"));
	return memory;
}

export function hookService(): HookService {
	hooks ??= new HookService(app.getPath("userData"));
	return hooks;
}

/**
 * The memory section for a prompt, or "" when the store cannot be read. A
 * damaged memory file is reported in settings; it must not stop a session.
 */
export function memorySection(cwd: string | undefined): string {
	try {
		return memoryStore().promptSection(cwd);
	} catch (error) {
		console.error("Could not read long-term memory:", error);
		return "";
	}
}
