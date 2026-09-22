/**
 * File-browser contract for the right dock's Files pane.
 *
 * Paths crossing the bridge are relative to the project root (`cwd`) and may
 * use either separator — main resolves them and refuses anything that escapes
 * the root.
 */
export interface FsEntry {
	name: string;
	/** Path relative to the project root. */
	relPath: string;
	kind: "dir" | "file";
}

export interface FsReadResult {
	/** Where the file sits under the project root, `/`-separated. */
	relPath: string;
	text: string;
	/** True when the file exceeded the read cap and only a prefix is returned. */
	truncated: boolean;
}

/** Files larger than this are not loaded into the dock preview. */
export const FS_READ_MAX_BYTES = 256 * 1024;

export interface HostDirectoryEntry {
	name: string;
	path: string;
}

export interface HostDirectoryListing {
	path: string;
	root: string;
	parent: string | null;
	directories: HostDirectoryEntry[];
	truncated: boolean;
}
