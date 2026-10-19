import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHistoryReader } from "../../src/main/session-history";

test("worker failures reject waiting requests and the next call starts a fresh worker", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-history-worker-"));
	const file = join(directory, "worker.cjs");
	const reader = new SessionHistoryReader(file);
	try {
		writeFileSync(file, "throw new Error('fixture worker failed');");
		const requests = [reader.list(directory), reader.list(directory)];
		const results = await Promise.allSettled(requests);
		expect(results.every(result => result.status === "rejected")).toBe(true);
		writeFileSync(file, "const {parentPort}=require('node:worker_threads');parentPort.on('message',({id})=>parentPort.postMessage({id,rows:[]}));");
		expect(await reader.list(directory)).toEqual([]);
	} finally {
		reader.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("closing the reader settles in-flight requests", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-history-close-"));
	const file = join(directory, "worker.cjs");
	const reader = new SessionHistoryReader(file);
	try {
		writeFileSync(file, "require('node:worker_threads').parentPort.on('message',()=>{});");
		const request = reader.list(directory);
		reader.close();
		await expect(request).rejects.toThrow("Session history reader closed");
	} finally {
		reader.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
