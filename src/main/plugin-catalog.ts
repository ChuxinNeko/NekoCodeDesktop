import { load } from "cheerio/slim";
import {
	PLUGIN_CATALOG_URL,
	PLUGIN_TYPES,
	type PluginCatalogEntry,
	type PluginCatalogPage,
	type PluginCatalogQuery,
} from "../shared/plugins";

export function pluginCatalogUrl(query: PluginCatalogQuery = {}): URL {
	const url = new URL(PLUGIN_CATALOG_URL);
	if (typeof query.search === "string" && query.search.trim()) {
		url.searchParams.set("name", query.search.trim().slice(0, 200));
	}
	if (query.type && PLUGIN_TYPES.includes(query.type))
		url.searchParams.set("type", query.type);
	url.searchParams.set(
		"sort",
		query.sort === "recent" || query.sort === "name" ? query.sort : "downloads",
	);
	const page =
		Number.isSafeInteger(query.page) && query.page! > 0 ? query.page! : 1;
	url.searchParams.set("page", String(page));
	return url;
}

/** pi.dev currently serves its catalog as HTML; /api/packages is reserved, not an API. */
export function parsePluginCatalog(html: string): PluginCatalogPage {
	const $ = load(html);
	const catalog = $(".packages-index-card");
	if (catalog.length !== 1)
		throw new Error("The PI package catalog format has changed.");
	const packages: PluginCatalogEntry[] = [];
	const seen = new Set<string>();
	catalog.find('[data-package-card="true"]').each((_index, element) => {
		const card = $(element);
		const name = card.attr("data-package-name") ?? "";
		// Only npm package identifiers from the catalog can become install sources.
		if (
			!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) ||
			seen.has(name)
		)
			return;
		seen.add(name);
		const types = (card.attr("data-package-types") ?? "").split(/[\s,]+/);
		const number = (attribute: string) => {
			const value = Number(card.attr(attribute));
			return Number.isFinite(value) && value >= 0 ? value : 0;
		};
		packages.push({
			name,
			description: card.find(".packages-desc").text().trim(),
			author: card.find(".packages-meta > span").first().text().trim(),
			types: PLUGIN_TYPES.filter((type) => types.includes(type)),
			downloads: number("data-package-downloads"),
			updatedAt: number("data-package-date"),
			url: `${PLUGIN_CATALOG_URL}/${name.split("/").map(encodeURIComponent).join("/")}`,
		});
	});
	if (!packages.length && !catalog.find(".packages-empty").length) {
		throw new Error("The PI package catalog contains no readable packages.");
	}
	const page = Number(catalog.find('[aria-current="page"]').text()) || 1;
	let pages = page;
	catalog.find(".packages-pagination a[href]").each((_index, element) => {
		const url = new URL($(element).attr("href")!, PLUGIN_CATALOG_URL);
		const value = Number(url.searchParams.get("page"));
		if (Number.isSafeInteger(value) && value > pages) pages = value;
	});
	return { packages, page, pages };
}

/** Small in-memory cache keeps tab switches quick; refresh always reaches the site. */
export class PluginCatalogService {
	private readonly cache = new Map<
		string,
		{ value: PluginCatalogPage; expires: number }
	>();
	private readonly pending = new Map<string, Promise<PluginCatalogPage>>();

	constructor(
		private readonly fetchPage: (
			url: string,
			init: RequestInit,
		) => Promise<Response> = fetch,
	) {}

	async list(query: PluginCatalogQuery = {}): Promise<PluginCatalogPage> {
		const url = pluginCatalogUrl(query).toString();
		const cached = this.cache.get(url);
		if (!query.refresh && cached && cached.expires > Date.now())
			return cached.value;
		const pending = this.pending.get(url);
		if (pending) return pending;
		const request = this.load(url);
		this.pending.set(url, request);
		try {
			return await request;
		} finally {
			this.pending.delete(url);
		}
	}

	private async load(url: string): Promise<PluginCatalogPage> {
		const response = await this.fetchPage(url, {
			signal: AbortSignal.timeout(15_000),
			headers: { Accept: "text/html" },
		});
		if (!response.ok)
			throw new Error(`PI package catalog: HTTP ${response.status}`);
		const value = parsePluginCatalog(await response.text());
		if (this.cache.size >= 40)
			this.cache.delete(this.cache.keys().next().value!);
		this.cache.set(url, { value, expires: Date.now() + 5 * 60_000 });
		return value;
	}
}
