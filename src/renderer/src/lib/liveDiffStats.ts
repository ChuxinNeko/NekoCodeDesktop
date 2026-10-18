/** Keep small edits granular; larger streaming edits publish five-line batches.
 * Settled results always show the exact count, including the final remainder. */
export function liveDiffCount(count: number, live: boolean): number {
	return live && count >= 5 ? Math.floor(count / 5) * 5 : count;
}

/** A streaming string's last line is still being generated. */
export function editTextLines(text: string, streaming = false): string[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (streaming || lines.at(-1) === "") lines.pop();
	return lines;
}
