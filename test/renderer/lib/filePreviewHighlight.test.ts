import { expect, test } from "bun:test";
import { createFilePreviewHighlighter } from "../../../src/renderer/src/lib/filePreviewHighlightClient";

function fakeWorker() {
	const requests: Array<{ id: number; code: string; filename: string }> = [];
	let terminated = false;
	const worker = {
		onmessage: null, onerror: null, onmessageerror: null,
		postMessage: (request: (typeof requests)[number]) => { requests.push(request); },
		terminate: () => { terminated = true; },
	} as unknown as Worker;
	return {
		worker, requests, terminated: () => terminated,
		reply: (id: number, html: string) => worker.onmessage?.call(worker, { data: { id, html } } as MessageEvent),
		fail: () => worker.onerror?.call(worker, {} as ErrorEvent),
	};
}

test("preview requests reuse the worker and route out-of-order results correctly", async () => {
	const fake = fakeWorker();
	let starts = 0;
	const highlight = createFilePreviewHighlighter(() => { starts++; return fake.worker; });
	const first = highlight("const a = 1", "a.ts", new AbortController().signal);
	const second = highlight("const b = 2", "b.ts", new AbortController().signal);
	expect(fake.requests.map(request => request.filename)).toEqual(["a.ts", "b.ts"]);
	fake.reply(fake.requests[1]!.id, "second");
	fake.reply(fake.requests[0]!.id, "first");
	expect(await first).toBe("first");
	expect(await second).toBe("second");
	expect(starts).toBe(1);
});

test("switching away cancels a preview and late results cannot replace the next file", async () => {
	const fake = fakeWorker();
	const highlight = createFilePreviewHighlighter(() => fake.worker);
	const controller = new AbortController();
	const first = highlight("old", "old.ts", controller.signal);
	controller.abort();
	expect(await first).toBeNull();
	const second = highlight("new", "new.ts", new AbortController().signal);
	fake.reply(fake.requests[0]!.id, "stale");
	fake.reply(fake.requests[1]!.id, "current");
	expect(await second).toBe("current");
	await expect(highlight("old", "old.ts", controller.signal)).resolves.toBeNull();
	expect(fake.requests).toHaveLength(2);
});

test("worker failure falls back to plain text for pending previews and retries on the next request", async () => {
	const workers = [fakeWorker(), fakeWorker()];
	let starts = 0;
	const highlight = createFilePreviewHighlighter(() => workers[starts++]!.worker);
	const first = highlight("first", "a.ts", new AbortController().signal);
	const second = highlight("second", "b.ts", new AbortController().signal);
	workers[0]!.fail();
	expect(await first).toBeNull();
	expect(await second).toBeNull();
	expect(workers[0]!.terminated()).toBe(true);
	const retry = highlight("retry", "c.ts", new AbortController().signal);
	workers[1]!.reply(workers[1]!.requests[0]!.id, "recovered");
	expect(await retry).toBe("recovered");
});

test("the actual worker highlights TypeScript without requiring the UI thread", async () => {
	const worker = new Worker(new URL("../../../src/renderer/src/lib/filePreviewHighlight.worker.ts", import.meta.url).href);
	try {
		const result = await new Promise<{ id: number; html: string }>((resolve, reject) => {
			worker.onmessage = event => resolve(event.data);
			worker.onerror = reject;
			worker.postMessage({ id: 42, code: "const value = 1;\nconsole.log(value);", filename: "example.ts" });
		});
		expect(result.id).toBe(42);
		expect(result.html).toContain('class="shiki');
		expect(result.html.match(/class="line"/g)).toHaveLength(2);
	} finally {
		worker.terminate();
	}
}, 15_000);
