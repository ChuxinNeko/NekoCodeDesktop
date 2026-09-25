/**
 * Project instructions: the AGENTS.md family the agent core reads into every
 * system prompt.
 *
 * The core looks for, in each directory, the first of
 * `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` —
 * once in the agent home for everything, then from the filesystem root down to
 * the working directory. This contract describes what it found, so the page can
 * show exactly what the model is being told.
 */

export const INSTRUCTION_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export type InstructionScope = "global" | "project" | "ancestor";

export interface InstructionFile {
	path: string;
	scope: InstructionScope;
	content: string;
}

export interface ProjectInstructions {
	cwd: string;
	/** What the core loads for this directory, in prompt order. */
	loaded: InstructionFile[];
	/** Where the global file is or would be created. */
	globalPath: string;
	/** Where this project's own file is or would be created. */
	projectPath: string;
	/**
	 * The project project-scoped memories and hooks belong to — the main
	 * checkout even when `cwd` is a worktree of it.
	 */
	projectRoot: string;
}

export interface SaveInstructionsRequest {
	cwd: string;
	scope: "global" | "project";
	content: string;
}

/** Past this the file is still loaded, but the editor refuses to grow it. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

export function isInstructionFileName(name: string): boolean {
	return (INSTRUCTION_FILE_NAMES as readonly string[]).includes(name);
}

/**
 * First line of the prompt `/init` expands into. The transcript shows the
 * command rather than the page of instructions it stands for.
 */
export const INIT_PROMPT_MARKER = "<!-- nekocode:init -->";
/** Where the user's own words go in that prompt, so they can be shown back. */
export const INIT_EXTRA_LABEL = "补充要求：";

/** `/init …` for an expanded init prompt, or null for any other text. */
export function displayInitPrompt(text: string): string | null {
	if (!text.startsWith(INIT_PROMPT_MARKER)) return null;
	const at = text.lastIndexOf(`\n${INIT_EXTRA_LABEL}`);
	const extra = at >= 0 ? text.slice(at + INIT_EXTRA_LABEL.length + 1).trim() : "";
	return extra ? `/init ${extra}` : "/init";
}
