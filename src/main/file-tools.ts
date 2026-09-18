import { open, lstat } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resolveWorkspacePath } from "./workflow-paths";

export const STAT_TOOL_NAME = "stat";

/** Paths per call. Enough for a whole feature directory in one round trip. */
const MAX_PATHS = 100;

/**
 * Files this size are measured, not counted.
 *
 * Counting lines means reading the bytes; past this the answer is not worth
 * the read, and "how many lines" was never the interesting question about a
 * 20MB file anyway.
 */
const MAX_COUNTED_BYTES = 20 * 1024 * 1024;

/** A NUL in the head of a file is the usual tell, and it is good enough here. */
const SNIFF_BYTES = 8192;

const statSchema = Type.Object(
	{
		paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
			minItems: 1,
			maxItems: MAX_PATHS,
			description: "Workspace-relative or absolute paths to measure.",
		}),
	},
	{ additionalProperties: false },
);

export interface StatEntry {
	path: string;
	kind?: "file" | "dir" | "other";
	bytes?: number;
	/** Absent for directories, binaries, and files past the counting limit. */
	lines?: number;
	binary?: boolean;
	/** Set instead of the rest when the path could not be measured. */
	error?: string;
}

/**
 * Count the lines in a file without holding it in memory.
 *
 * Chunked because this tool exists to answer questions about whole directories
 * at once, and reading each file whole to count its newlines would make the
 * cheap question expensive again.
 */
async function measure(target: string, bytes: number): Promise<Omit<StatEntry, "path">> {
	if (bytes === 0) return { kind: "file", bytes, lines: 0, binary: false };
	const file = await open(target, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		let lines = 0;
		let read = 0;
		let lastByte = 0;
		let binary = false;
		for (;;) {
			const { bytesRead } = await file.read(buffer, 0, buffer.length, read);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			if (!binary && read < SNIFF_BYTES && chunk.includes(0)) binary = true;
			if (binary) return { kind: "file", bytes, binary: true };
			for (let i = 0; i < bytesRead; i++) if (chunk[i] === 0x0a) lines++;
			lastByte = chunk[bytesRead - 1];
			read += bytesRead;
		}
		// A file that does not end in a newline still has a last line.
		if (lastByte !== 0x0a) lines++;
		return { kind: "file", bytes, lines, binary: false };
	} finally {
		await file.close();
	}
}

/**
 * Measure a batch of paths, reporting one entry per path in the order asked.
 *
 * A path that cannot be measured reports its error in place rather than
 * failing the call: one bad path in a directory listing must not cost the
 * caller the other ninety-nine.
 *
 * Kept apart from the tool so the counting — which is the part that can be
 * wrong — is tested without standing up an extension context.
 */
export async function statPaths(
	cwd: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<StatEntry[]> {
	const entries: StatEntry[] = [];
	for (const path of paths) {
		if (signal?.aborted) throw new Error("Tool call cancelled");
		try {
			const target = resolveWorkspacePath(cwd, path);
			const info = await lstat(target);
			if (info.isDirectory()) entries.push({ path, kind: "dir" });
			else if (!info.isFile()) entries.push({ path, kind: "other" });
			else if (info.size > MAX_COUNTED_BYTES)
				entries.push({ path, kind: "file", bytes: info.size });
			else entries.push({ path, ...(await measure(target, info.size)) });
		} catch (error) {
			entries.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return entries;
}

/**
 * How big is this file — the question the read tool cannot be asked.
 *
 * `read` reports a total line count only in a truncation footer or an
 * out-of-bounds error, and `ls` reports no sizes at all, so an agent that wants
 * to know how large something is before reading it has to provoke an error to
 * find out. Agents did exactly that: `read(offset: 999999)` to harvest the
 * "(780 lines total)" out of the failure message, once per file.
 *
 * Strictly read-only, so it is available wherever `read` is — including the
 * background workers, which is where the probing was costing the most.
 */
export function createStatTool(cwd: string): ToolDefinition {
	return {
		name: STAT_TOOL_NAME,
		label: STAT_TOOL_NAME,
		description:
			"Measure files without reading them: size in bytes, line count, and whether the content is binary. Takes many paths at once. Use this instead of probing with read offsets when you need to know how large a file is.",
		promptSnippet:
			"stat(paths) reports bytes/lines/binary for many files at once; never probe file size with out-of-range read offsets.",
		parameters: statSchema,
		// Measuring files touches nothing, so several of these can run at once.
		executionMode: "parallel",
		async execute(_id, params, signal) {
			if (signal?.aborted) throw new Error("Tool call cancelled");
			const { paths } = params as Static<typeof statSchema>;
			const entries = await statPaths(cwd, paths, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(entries) }],
				details: entries,
			};
		},
	};
}
