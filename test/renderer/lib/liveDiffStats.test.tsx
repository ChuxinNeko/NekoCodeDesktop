import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { editTextLines, liveDiffCount } from "../../../src/renderer/src/lib/liveDiffStats";
import { DiffStat } from "../../../src/renderer/src/components/ui/diff-stat";

describe("live work-log diff counts", () => {
	test("publishes complete streamed lines, leaving an unfinished line uncounted", () => {
		expect(editTextLines("first", true)).toEqual([]);
		expect(editTextLines("first\n", true)).toEqual(["first"]);
		expect(editTextLines("first\r\nsecond\r\npart", true)).toEqual(["first", "second"]);
		expect(editTextLines("first\nsecond", false)).toEqual(["first", "second"]);
		expect(editTextLines("", true)).toEqual([]);
	});

	test("updates small edits line by line and larger edits in five-line batches", () => {
		expect(Array.from({ length: 17 }, (_, count) => liveDiffCount(count, true)))
			.toEqual([0, 1, 2, 3, 4, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 15, 15]);
		expect(liveDiffCount(13, false)).toBe(13);
		expect(liveDiffCount(0, false)).toBe(0);
	});

	test("rolls decimal columns while exposing readable values to assistive technology", () => {
		const html = renderToStaticMarkup(<DiffStat insertions={125} deletions={4} animate />);
		expect(html).toContain('aria-label="125"');
		expect(html).toContain('aria-label="4"');
		expect(html).toContain("motion-safe:transition-transform");
		expect(html).toContain("translateY(-50%)");
		expect(html).toContain("text-success");
		expect(html).toContain("text-destructive");
		const settled = renderToStaticMarkup(<DiffStat insertions={125} deletions={4} />);
		expect(settled).not.toContain("translateY");
	});
});
