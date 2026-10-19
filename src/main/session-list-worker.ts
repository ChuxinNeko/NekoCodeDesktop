import { parentPort } from "node:worker_threads";
import { collectSessions } from "./session-index";
import type { SessionHistoryRequest, SessionHistoryReply } from "./session-history";

let tail: Promise<unknown> = Promise.resolve();

parentPort!.on("message", (request: SessionHistoryRequest) => {
	// One scan at a time: two overlapping lists would rewrite the index out from under each other.
	tail = tail.then(() => respond(request)).catch(() => undefined);
});

async function respond({ id, directory, cwd }: SessionHistoryRequest): Promise<void> {
	try {
		const rows = await collectSessions(directory, cwd);
		parentPort!.postMessage({ id, rows } satisfies SessionHistoryReply);
	} catch (cause) {
		parentPort!.postMessage({ id, error: cause instanceof Error ? cause.message : String(cause) } satisfies SessionHistoryReply);
	}
}
