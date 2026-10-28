import { constants, closeSync, fchownSync, fstatSync, lchownSync, lstatSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Walk anchored directory descriptors, never symlinks; only repair files created by root. */
export function repairProfileOwnership(path: string, uid: number, gid: number): void {
	if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) throw new Error("Invalid profile owner");
	let info;
	try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	if (info.isSymbolicLink()) return;
	if (!info.isDirectory()) {
		if (info.uid === 0 && info.nlink === 1) lchownSync(path, uid, gid);
		return;
	}
	const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		if (info.uid === 0) fchownSync(directory, uid, gid);
		const anchor = `/proc/self/fd/${directory}`;
		for (const name of readdirSync(anchor)) {
			const entry = join(anchor, name);
			try {
				const child = lstatSync(entry);
				if (child.isSymbolicLink() || child.dev !== info.dev) continue;
				if (child.isDirectory()) repairProfileOwnership(entry, uid, gid);
				else if (child.uid === 0 && child.nlink === 1) lchownSync(entry, uid, gid);
			} catch (error) {
				// An atomic store can replace or remove an entry while the sweep runs.
				if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
		}
	} finally { closeSync(directory); }
}

/** Repair a watcher event without scanning the whole session history, or following a swapped ancestor. */
export function repairChangedProfileEntry(root: string, relative: string, uid: number, gid: number): void {
	if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) throw new Error("Invalid profile owner");
	const parts = relative.split(/[\\/]/);
	if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) return;
	let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const device = fstatSync(fd).dev;
		for (const part of parts.slice(0, -1)) {
			const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			const info = fstatSync(next);
			if (info.dev !== device) { closeSync(next); return; }
			if (info.uid === 0) fchownSync(next, uid, gid);
			closeSync(fd); fd = next;
		}
		repairProfileOwnership(`/proc/self/fd/${fd}/${parts[parts.length - 1]}`, uid, gid);
	} finally { closeSync(fd); }
}
