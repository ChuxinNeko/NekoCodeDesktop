/**
 * Long-term memory: facts that outlive a session.
 *
 * Two scopes, because the two kinds of fact travel differently. A preference
 * about how the user likes to work ("answer in Chinese", "never add
 * comments") follows them into every project; a convention of one codebase
 * ("tests live beside the source", "use bun, not npm") would be wrong
 * anywhere else.
 *
 * Kept in the app's own data rather than in the repository: memory is the
 * user's, and writing it into a project would put it in someone else's diff.
 */

export type MemoryScope = "user" | "project";

export interface MemoryEntry {
	id: string;
	scope: MemoryScope;
	/** The project root a project memory belongs to. Absent for user scope. */
	project?: string;
	text: string;
	/** Who wrote it — the user in settings, or the agent through its tool. */
	source: "user" | "agent";
	createdAt: number;
	updatedAt: number;
}

export interface SaveMemoryRequest {
	/** Absent to add a new entry. */
	id?: string;
	scope: MemoryScope;
	/** Any directory inside the project; required for project scope. */
	cwd?: string;
	text: string;
}

export interface MemorySnapshot {
	entries: MemoryEntry[];
}

/** One entry's length. A memory is a sentence or two, not a document. */
export const MAX_MEMORY_TEXT = 1000;
/** Entries per scope (per project for project scope). */
export const MAX_MEMORIES_PER_SCOPE = 100;
