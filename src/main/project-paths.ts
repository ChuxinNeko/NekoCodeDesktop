import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Is `target` the root itself, or something beneath it? */
function contains(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The on-disk spelling of a path, or the path itself when it cannot be read. */
function canonical(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

export interface ResolvedProjectPath {
	root: string;
	target: string;
	/** `target` against `root`, in the `/`-separated form the Files pane shows. */
	relPath: string;
}

/**
 * Resolve a path the dock's Files pane asked for, refusing anything outside the
 * project root.
 *
 * Checked twice, because one location has more than one spelling. Windows hands
 * out 8.3 short names, junctions, subst drives and redirected profile folders —
 * OneDrive's Documents is one — so a tool result and the project root can name
 * the same directory two ways that no string comparison will match, and reading
 * a file the agent just read fails with "escapes project root".
 *
 * The literal comparison runs first and unchanged, so a symlink inside the
 * project still resolves the way it always did; only a path it rejects is
 * canonicalized and asked again. Nothing outside the root gains entry either
 * way: a real path lands inside the real root only by being inside it.
 */
export function resolveUnderRoot(cwd: string, requested: string): ResolvedProjectPath {
	const root = resolve(cwd);
	const target = resolve(root, requested);
	if (contains(root, target)) return found(root, target);
	const realRoot = canonical(root);
	const realTarget = canonical(target);
	if (contains(realRoot, realTarget)) return found(realRoot, realTarget);
	// Both sides named, because the interesting case is two spellings of one
	// place and the request alone never shows which root it was measured against.
	throw new Error(`Path escapes project root: ${requested} (root: ${root})`);
}

function found(root: string, target: string): ResolvedProjectPath {
	return { root, target, relPath: relative(root, target).split(sep).join("/") };
}
