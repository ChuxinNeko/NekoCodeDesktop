import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function canonical(value: string): string {
	let cursor = resolve(value);
	const tail: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) throw new Error("Cannot resolve path: " + value);
		tail.unshift(basename(cursor));
		cursor = parent;
	}
	const result = join(realpathSync(cursor), ...tail);
	return process.platform === "win32" ? result.toLowerCase() : result;
}
export function containsPath(parent: string, child: string): boolean {
	const suffix = relative(parent, child);
	return (
		suffix === "" || (!suffix.startsWith(".." + sep) && suffix !== ".." && !isAbsolute(suffix))
	);
}
/** Resolve existing symlinks and missing descendants before checking a worker's write boundary. */
export function resolveWorkspacePath(cwd: string, value: string): string {
	if (!value.trim() || value.includes("\0")) throw new Error("Invalid workspace path");
	const root = canonical(cwd);
	const target = canonical(resolve(cwd, value));
	if (!containsPath(root, target)) throw new Error("Path is outside the workspace: " + value);
	return target;
}
export function pathsOverlap(a: string, b: string): boolean {
	return containsPath(a, b) || containsPath(b, a);
}
