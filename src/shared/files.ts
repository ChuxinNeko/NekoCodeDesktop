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

export type FsReadResult =
	| {
			kind: "text";
			/** Where the file sits under the project root, `/`-separated. */
			relPath: string;
			text: string;
			/** True when the file exceeded the read cap and only a prefix is returned. */
			truncated: boolean;
	  }
	| {
			kind: "image";
			relPath: string;
			/** `data:` URL of the whole image. */
			dataUrl: string;
			size: number;
	  }
	| {
			/** Non-text content the pane cannot render (or an image over the cap). */
			kind: "binary";
			relPath: string;
			size: number;
	  };

/** Text files larger than this are only previewed up to this prefix. */
export const FS_READ_MAX_BYTES = 256 * 1024;

/** Images larger than this are reported as binary instead of being inlined. */
export const FS_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Raster image types the dock previews inline, keyed by lower-case extension. */
export const FS_IMAGE_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	avif: "image/avif",
};

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
