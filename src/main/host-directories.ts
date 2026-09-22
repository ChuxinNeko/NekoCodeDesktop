import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import type { HostDirectoryEntry, HostDirectoryListing } from "../shared/files";

export const HOST_DIRECTORY_LIMIT = 2000;

export async function listHostDirectories(value: unknown): Promise<HostDirectoryListing> {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !isAbsolute(value)) {
		throw new Error("路径无效");
	}
	let canonical = await realpath(value).catch(() => {
		throw new Error("目录不存在或无法访问");
	});
	if (parse(canonical).root === canonical && !canonical.endsWith(sep)) canonical += sep;
	const info = await stat(canonical).catch(() => {
		throw new Error("目录不存在或无法访问");
	});
	if (!info.isDirectory()) throw new Error("这不是一个文件夹");
	const dirents = await readdir(canonical, { withFileTypes: true }).catch(() => {
		throw new Error("目录不存在或无法访问");
	});
	const directories: HostDirectoryEntry[] = [];
	for (const dirent of dirents) {
		if (!dirent.isDirectory()) {
			if (!dirent.isSymbolicLink()) continue;
			const full = join(canonical, dirent.name);
			const target = await stat(full).catch(() => null);
			if (!target?.isDirectory()) continue;
		}
		directories.push({ name: dirent.name, path: join(canonical, dirent.name) });
	}
	directories.sort((a, b) => a.name.localeCompare(b.name));
	const truncated = directories.length > HOST_DIRECTORY_LIMIT;
	const parent = dirname(canonical);
	return {
		path: canonical,
		root: parse(canonical).root,
		parent: parent === canonical ? null : parent,
		directories: directories.slice(0, HOST_DIRECTORY_LIMIT),
		truncated,
	};
}
