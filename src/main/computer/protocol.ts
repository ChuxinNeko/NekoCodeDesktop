/**
 * Messages between the main process and the Computer Use worker.
 *
 * The driver runs in its own utility process: it is a 25 MB native library
 * that injects input into other applications, and a crash or a wedged call in
 * it must cost one worker, not the window the user is typing into. Killing
 * that process is also the only stop that is certain to end a native action.
 */

export interface ComputerImage {
	/** Base64, without a data: prefix. */
	data: string;
	mimeType: string;
}

/** A driver tool result, reduced to what the tools layer reads. */
export interface ComputerCallResult {
	text: string;
	images: ComputerImage[];
	isError: boolean;
	errorCode?: string;
	/** The driver's structured payload as JSON text, when it sent one. */
	structuredJson?: string;
}

/**
 * Calls the worker answers itself instead of passing to the driver. The prefix
 * cannot collide with a driver tool name, which are plain snake_case.
 */
export const RAISE_WINDOW = "nekocode.raise_window";

export type WorkerRequest =
	| { type: "call"; id: number; name: string; args: Record<string, unknown> }
	| { type: "cancel"; id: number };

export type WorkerResponse =
	| { type: "ready" }
	| { type: "fatal"; message: string }
	| { type: "result"; id: number; result: ComputerCallResult }
	| { type: "error"; id: number; message: string };
