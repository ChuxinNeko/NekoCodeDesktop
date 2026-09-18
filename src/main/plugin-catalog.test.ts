import { describe, expect, test } from "bun:test";
import {
	PluginCatalogService,
	parsePluginCatalog,
	pluginCatalogUrl,
} from "./plugin-catalog";

const card = `<article data-package-card="true" data-package-name="@owner/example"
	data-package-types="extension,skill" data-package-downloads="1234" data-package-date="1789708112206">
	<p class="packages-desc">Search &amp; edit &lt;files&gt; &#x1F431;</p>
	<div class="packages-meta"><span>Alice &amp; Bob</span><span>1.2K/mo</span></div>
</article>`;
const fixture = `<section class="packages-recent-card">${card}</section>
<section class="packages-index-card">${card}
<nav class="packages-pagination"><span aria-current="page">2</span>
<a href="/packages?name=search&amp;page=3">Next</a><a href="/packages?page=109">109</a></nav></section>`;

describe("PI catalog", () => {
	test("reads only catalog cards, decodes text, and retains scoped identities and pagination", () => {
		const result = parsePluginCatalog(fixture);
		expect(result).toEqual({
			packages: [
				{
					name: "@owner/example",
					description: "Search & edit <files> 🐱",
					author: "Alice & Bob",
					types: ["extension", "skill"],
					downloads: 1234,
					updatedAt: 1789708112206,
					url: "https://pi.dev/packages/%40owner/example",
				},
			],
			page: 2,
			pages: 109,
		});
	});

	test("distinguishes an empty search from a changed page or challenge page", () => {
		expect(
			parsePluginCatalog(
				'<section class="packages-index-card"><p class="packages-empty">No results</p></section>',
			),
		).toEqual({ packages: [], page: 1, pages: 1 });
		expect(() => parsePluginCatalog("<html>Please sign in</html>")).toThrow(
			"format has changed",
		);
		expect(() =>
			parsePluginCatalog('<section class="packages-index-card"></section>'),
		).toThrow("no readable packages");
	});

	test("rejects invalid install names, deduplicates packages, and defaults missing metadata", () => {
		const html = `<section class="packages-index-card">${card}${card}
		<article data-package-card="true" data-package-name="bad --flag"></article>
		<article data-package-card="true" data-package-name="../bad"></article>
		<article data-package-card="true" data-package-name="pi-theme" data-package-downloads="NaN" data-package-date="-1"></article></section>`;
		const result = parsePluginCatalog(html);
		expect(result.packages.map((entry) => entry.name)).toEqual([
			"@owner/example",
			"pi-theme",
		]);
		expect(result.packages[1]).toMatchObject({
			downloads: 0,
			updatedAt: 0,
			types: [],
			author: "",
			description: "",
		});
	});

	test("constructs fixed-origin, escaped official filter URLs", () => {
		const url = pluginCatalogUrl({
			search: "  a&sort=name  ",
			type: "theme",
			sort: "recent",
			page: 4,
		});
		expect(url.origin).toBe("https://pi.dev");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			name: "a&sort=name",
			type: "theme",
			sort: "recent",
			page: "4",
		});
		expect(pluginCatalogUrl({ page: -2 }).searchParams.get("page")).toBe("1");
	});

	test("caches and coalesces identical requests, while refresh and different filters fetch again", async () => {
		let calls = 0;
		const service = new PluginCatalogService(async (_url, init) => {
			calls++;
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response(fixture);
		});
		const [first, second] = await Promise.all([service.list(), service.list()]);
		expect(first).toEqual(second);
		await service.list();
		expect(calls).toBe(1);
		await service.list({ refresh: true });
		await service.list({ type: "theme" });
		expect(calls).toBe(3);
	});

	test("HTTP and network failures do not poison retries", async () => {
		let calls = 0;
		const service = new PluginCatalogService(async () => {
			calls++;
			if (calls === 1) return new Response("unavailable", { status: 503 });
			if (calls === 2) throw new Error("offline");
			return new Response(fixture);
		});
		await expect(service.list()).rejects.toThrow("HTTP 503");
		await expect(service.list()).rejects.toThrow("offline");
		expect((await service.list()).packages).toHaveLength(1);
		expect(calls).toBe(3);
	});
});
