import type { Context } from "@earendil-works/chord";
import type { TruncationResult } from "./utils/truncate.ts";

/** Result of a fallible operation. Expected failures are returned instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

export type FileKind = "file" | "directory" | "symlink";

export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

export class FileError extends Error {
	public code: FileErrorCode;
	public path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

export class ExecutionError extends Error {
	public code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

export interface FileInfo {
	name: string;
	path: string;
	kind: FileKind;
	size: number;
	mtimeMs: number;
}

export interface TextLine {
	text: string;
	terminated: boolean;
}

export interface TextLineReader {
	readLine(context: Context): Promise<Result<TextLine | undefined, FileError>>;
	close(context: Context): Promise<void>;
}

/** Portable filesystem capability. Operations return failures rather than throwing. */
export interface FileSystem {
	cwd: string;
	absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>>;
	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>>;
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** Truncate or extend a file to exactly `size` bytes. */
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>>;
	/** Flush file contents and metadata needed to retrieve them from an open file handle. */
	flushFile(path: string, context: Context): Promise<Result<void, FileError>>;
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
	exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>>;
	cleanup(context: Context): Promise<void>;
}

export type ShellOutputRetention = "head" | "tail";

export interface ShellOutputLimits {
	maxBytes: number;
	maxLines: number;
	retain?: ShellOutputRetention;
}

export interface ShellOutputCaptureOptions {
	limits: ShellOutputLimits;
	spill?: boolean;
}

export type ShellOutputTruncation = Omit<TruncationResult, "content">;

export interface ShellOutputMetadata {
	truncation: ShellOutputTruncation;
	spillPath?: string;
	lastLineBytes?: number;
}

export interface ShellOutputView extends ShellOutputMetadata {
	text: string;
}

export type ShellOutputUpdate =
	| { kind: "replace"; output: ShellOutputView }
	| { kind: "append"; text: string; metadata: ShellOutputMetadata }
	| { kind: "slide"; drop: number; text: string; metadata: ShellOutputMetadata }
	| { kind: "metadata"; metadata: ShellOutputMetadata };

export interface ShellExecResult extends ShellOutputMetadata {
	exitCode: number;
}

export interface ShellExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	timeout?: number;
	capture?: ShellOutputCaptureOptions;
	onUpdate?: (update: ShellOutputUpdate, context: Context) => void;
}

export interface Shell {
	exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>>;
	cleanup(context: Context): Promise<void>;
}

export interface ExecutionEnv extends FileSystem, Shell {}
