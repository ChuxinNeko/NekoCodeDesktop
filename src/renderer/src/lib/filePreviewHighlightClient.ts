type HighlightResult = { id: number; html: string | null };

/** One persistent worker retains compiled grammars without blocking UI frames. */
export function createFilePreviewHighlighter(createWorker: () => Worker) {
	let worker: Worker | undefined;
	let nextId = 0;
	const pending = new Map<number, (html: string | null) => void>();
	const fail = () => {
		worker?.terminate();
		worker = undefined;
		for (const finish of [...pending.values()]) finish(null);
	};
	return (code: string, filename: string, signal: AbortSignal): Promise<string | null> => {
		if (signal.aborted) return Promise.resolve(null);
		return new Promise(resolve => {
			const id = ++nextId;
			const finish = (html: string | null) => {
				pending.delete(id);
				signal.removeEventListener("abort", abort);
				resolve(html);
			};
			const abort = () => finish(null);
			pending.set(id, finish);
			signal.addEventListener("abort", abort, { once: true });
			try {
				if (!worker) {
					worker = createWorker();
					worker.onmessage = ({ data }: MessageEvent<HighlightResult>) => pending.get(data.id)?.(data.html);
					worker.onerror = fail;
					worker.onmessageerror = fail;
				}
				worker.postMessage({ id, code, filename });
			} catch {
				fail();
			}
		});
	};
}

