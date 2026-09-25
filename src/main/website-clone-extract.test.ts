import { describe, expect, test } from "bun:test";
import {
	compareExtractions,
	extractionExpression,
	primaryFontFamily,
	renderComparison,
	type ExtractedNode,
	type Extraction,
} from "./website-clone-extract";

function node(partial: Partial<ExtractedNode> & { tag: string; path: string }): ExtractedNode {
	return { selector: partial.tag, rect: [0, 0, 100, 20], styles: {}, ...partial };
}

function extraction(targets: Extraction["targets"], width = 1440): Extraction {
	return {
		version: 1,
		url: "https://example.com/",
		title: "Example",
		viewport: { width, height: 900, dpr: 1 },
		scroll: { x: 0, y: 0 },
		document: { scrollWidth: width, scrollHeight: 3000 },
		targets,
		nodes: 0,
		truncated: false,
	};
}

const heading = (styles: Record<string, string>, rect: ExtractedNode["rect"] = [20, 40, 400, 48]) =>
	node({ tag: "h1", path: "0", text: "Build faster", rect, styles });

describe("primaryFontFamily", () => {
	test("sees through next/font's renamed families", () => {
		expect(primaryFontFamily("__Inter_aaf875, __Inter_Fallback_aaf875")).toBe("inter");
		expect(primaryFontFamily("__Inter_Fallback_aaf875")).toBe("inter");
		expect(primaryFontFamily("__Geist_Mono_9e72d2, monospace")).toBe("geist mono");
		expect(primaryFontFamily('"Inter", system-ui, sans-serif')).toBe("inter");
	});
});

describe("compareExtractions (text)", () => {
	test("pairs nodes by text and reports what differs", () => {
		const source = extraction({
			hero: node({
				tag: "section",
				path: "",
				rect: [0, 0, 1440, 600],
				styles: { paddingTop: "96px", backgroundColor: "rgb(10, 10, 10)" },
				children: [
					heading({ fontSize: "56px", fontFamily: "Inter, sans-serif", color: "rgb(255, 255, 255)" }),
					node({ tag: "p", path: "1", text: "Ship it", rect: [20, 100, 400, 24] }),
					node({ tag: "img", path: "2", rect: [700, 40, 600, 400] }),
				],
			}),
		});
		const clone = extraction({
			hero: node({
				tag: "section",
				path: "",
				rect: [0, 0, 1440, 600],
				// 1px of padding and 1 unit of color are inside tolerance.
				styles: { paddingTop: "96.4px", backgroundColor: "rgb(11, 10, 10)" },
				children: [
					node({
						tag: "div",
						path: "0",
						children: [
							heading(
								{ fontSize: "48px", fontFamily: "__Inter_aaf875, __Inter_Fallback_aaf875", color: "rgb(255, 255, 255)" },
								[20, 52, 400, 48],
							),
						],
					}),
					node({ tag: "p", path: "1", text: "Sign up", rect: [20, 100, 400, 24] }),
					node({ tag: "img", path: "2", rect: [700, 40, 600, 380] }),
				],
			}),
		});
		const result = compareExtractions(source, clone);
		const details = result.issues.map((issue) => `${issue.kind} ${issue.detail}`);
		expect(details).toContain("style fontSize: 56px → 48px");
		expect(details).toContain("rect relative to target y 40 → 52");
		expect(details).toContain('missing-text "Ship it"');
		expect(details).toContain('extra-text "Sign up"');
		expect(details).toContain("media img #1 size 600x400 → 600x380");
		// Root padding/color within tolerance and the renamed font family are not differences.
		expect(details.some((detail) => detail.includes("paddingTop") || detail.includes("fontFamily"))).toBe(false);
		expect(details.some((detail) => detail.includes("backgroundColor"))).toBe(false);
	});

	test("pairs a repeated label with its own occurrence", () => {
		const item = (path: string, y: number, color: string) =>
			node({ tag: "a", path, text: "Learn more", rect: [0, y, 80, 20], styles: { color } });
		const source = extraction({
			list: node({ tag: "ul", path: "", children: [item("0", 0, "rgb(0, 0, 255)"), item("1", 100, "rgb(255, 0, 0)")] }),
		});
		const clone = extraction({
			list: node({ tag: "ul", path: "", children: [item("0", 0, "rgb(0, 0, 255)"), item("1", 100, "rgb(0, 0, 255)")] }),
		});
		const styleIssues = compareExtractions(source, clone).issues.filter((issue) => issue.kind === "style");
		expect(styleIssues).toHaveLength(1);
		expect(styleIssues[0]!.detail).toBe("color: rgb(255, 0, 0) → rgb(0, 0, 255)");
	});

	test("reports a ::after the clone does not draw", () => {
		const link = (pseudo?: ExtractedNode["pseudo"]) =>
			extraction({ cta: node({ tag: "a", path: "", children: [node({ tag: "span", path: "0", text: "Learn more", pseudo })] }) });
		const result = compareExtractions(link({ after: { content: '"→"', color: "rgb(0, 0, 238)" } }), link());
		expect(result.issues.map((issue) => issue.detail)).toContain('::after: "→" → (none)');
	});

	test("reports missing targets, selector errors and mismatched viewports", () => {
		const source = extraction({ nav: node({ tag: "nav", path: "" }), footer: { error: "No element matches footer" } }, 1440);
		const clone = extraction({ footer: node({ tag: "footer", path: "" }) }, 390);
		const result = compareExtractions(source, clone);
		expect(result.counts["missing-target"]).toBe(1);
		expect(result.counts["target-error"]).toBe(1);
		expect(renderComparison(result)).toContain("different viewports");
	});
});

describe("compareExtractions (path)", () => {
	test("records what an interaction changed on the same page", () => {
		const header = (styles: Record<string, string>, menuHidden: boolean) =>
			extraction({
				header: node({
					tag: "header",
					path: "",
					styles,
					children: [node({ tag: "nav", path: "0", hidden: menuHidden || undefined })],
				}),
			});
		const before = header({ backgroundColor: "rgba(0, 0, 0, 0)" }, true);
		const after = header({ backgroundColor: "rgb(255, 255, 255)", boxShadow: "rgba(0, 0, 0, 0.1) 0px 4px 20px 0px" }, false);
		const details = compareExtractions(before, after, { mode: "path" }).issues.map((issue) => issue.detail);
		expect(details).toContain(
			"root backgroundColor: rgba(0, 0, 0, 0) → rgb(255, 255, 255); boxShadow: (default) → rgba(0, 0, 0, 0.1) 0px 4px 20px 0px",
		);
		expect(details).toContain("hidden: true → false");
	});
});

describe("extractionExpression", () => {
	test("is a self-contained call the page can evaluate", () => {
		const expression = extractionExpression({ targets: { hero: "main > section" }, maxDepth: 4, maxNodes: 10 });
		expect(expression.startsWith("(function")).toBe(true);
		expect(expression).toContain('{"targets":{"hero":"main > section"},"maxDepth":4,"maxNodes":10}');
		// Parses as JavaScript on its own, without the module around it.
		expect(() => new Function(`return ${expression}`)).not.toThrow();
	});
});
