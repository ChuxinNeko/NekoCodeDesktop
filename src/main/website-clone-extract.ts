/**
 * One extractor for every measurement the clone workflow takes, and one
 * comparison over its output.
 *
 * QA compares the source page with the clone by running the same extraction on
 * both. When the model wrote that script itself, the two runs rarely were the
 * same script, and it then compared two large JSON results by reading them —
 * which is where differences went unnoticed. Here the extraction is fixed and
 * the comparison is code.
 */

export const EXTRACTION_VERSION = 1;

export interface ExtractedNode {
	tag: string;
	/** Index path from the target root, e.g. "0.2.1" — stable across states of one page. */
	path: string;
	/** A readable CSS path to find the node again. */
	selector: string;
	/** Document coordinates [x, y, width, height] in CSS pixels. */
	rect: [number, number, number, number];
	/** The node's own text (not its children's), whitespace-collapsed. */
	text?: string;
	attrs?: Record<string, string>;
	styles: Record<string, string>;
	pseudo?: { before?: Record<string, string>; after?: Record<string, string> };
	/** Inline SVG markup when small enough to rebuild the icon from. */
	svg?: string;
	hidden?: boolean;
	children?: ExtractedNode[];
	/** Children left out by the depth or node budget. */
	omitted?: number;
}

export interface Extraction {
	version: number;
	url: string;
	title: string;
	viewport: { width: number; height: number; dpr: number };
	scroll: { x: number; y: number };
	document: { scrollWidth: number; scrollHeight: number };
	targets: Record<string, ExtractedNode | { error: string }>;
	nodes: number;
	truncated: boolean;
}

export interface ExtractOptions {
	/** Name → CSS selector. The same names on source and clone are compared with each other. */
	targets: Record<string, string>;
	maxDepth: number;
	maxNodes: number;
}

/**
 * Runs inside the inspected page, serialized with `toString()`: it may not
 * refer to anything outside its own body.
 */
export function extractInPage(options: ExtractOptions) {
	const STYLE_PROPS = [
		"display", "position", "top", "right", "bottom", "left", "zIndex", "boxSizing",
		"maxWidth", "minWidth", "maxHeight", "minHeight",
		"marginTop", "marginRight", "marginBottom", "marginLeft",
		"paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
		"flexDirection", "flexWrap", "justifyContent", "alignItems", "alignSelf", "flexGrow", "flexShrink", "flexBasis",
		"rowGap", "columnGap", "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow",
		"fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "color",
		"textAlign", "textTransform", "textDecorationLine", "whiteSpace", "textOverflow", "webkitLineClamp",
		"backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat",
		"borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
		"borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
		"borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
		"borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
		"boxShadow", "opacity", "transform", "filter", "backdropFilter", "mixBlendMode",
		"overflowX", "overflowY", "objectFit", "objectPosition", "cursor", "pointerEvents",
		"transitionProperty", "transitionDuration", "transitionTimingFunction", "transitionDelay",
		"animationName", "animationDuration", "animationTimingFunction", "animationIterationCount",
		"scrollSnapType", "scrollSnapAlign", "aspectRatio",
	];
	const PSEUDO_PROPS = [
		"content", "display", "position", "top", "right", "bottom", "left", "width", "height",
		"backgroundColor", "backgroundImage", "color", "opacity", "transform", "borderTopLeftRadius",
	];
	const COLOR_PROPS = new Set([
		"color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
	]);
	const BORING = new Set(["", "none", "normal", "auto", "0px", "0s", "0", "visible", "static", "rgba(0, 0, 0, 0)"]);
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD", "BASE"]);
	const ATTRS = ["id", "href", "src", "alt", "title", "role", "aria-label", "aria-expanded", "aria-selected",
		"type", "placeholder", "name", "target", "tabindex", "data-state", "poster", "srcset", "sizes", "loading"];
	const SVG_MAX = 4000;

	// Computed colors come back in whatever space the stylesheet wrote them in —
	// `oklch(...)` from Tailwind v4, `rgb(...)` from most sites. Painting one
	// pixel resolves every form to the same sRGB bytes, so they compare.
	const colorCache = new Map<string, string>();
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const normalizeColor = (value: string): string => {
		if (!ctx || !value || value === "transparent") return value;
		const cached = colorCache.get(value);
		if (cached !== undefined) return cached;
		let result = value;
		try {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = "#000";
			ctx.fillStyle = value;
			ctx.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
			result = a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
			if (a === 0) result = "rgba(0, 0, 0, 0)";
		} catch {
			/* Keep the value as the page reported it. */
		}
		colorCache.set(value, result);
		return result;
	};

	const round = (value: number) => Math.round(value * 10) / 10;
	const clean = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

	const readStyles = (style: CSSStyleDeclaration, props: string[]) => {
		const out: Record<string, string> = {};
		for (const prop of props) {
			let value = String((style as unknown as Record<string, string>)[prop] ?? "");
			if (COLOR_PROPS.has(prop)) value = normalizeColor(value);
			if (!BORING.has(value)) out[prop] = value;
		}
		return out;
	};

	const cssPath = (element: Element): string => {
		const parts: string[] = [];
		let current: Element | null = element;
		for (let depth = 0; current && depth < 5; depth++) {
			if (current.id) {
				parts.unshift("#" + CSS.escape(current.id));
				break;
			}
			let part = current.localName;
			const parent: Element | null = current.parentElement;
			if (parent) {
				const same = Array.from(parent.children).filter((child) => child.localName === current!.localName);
				if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
			}
			parts.unshift(part);
			current = parent;
		}
		return parts.join(" > ");
	};

	let budget = options.maxNodes;
	let truncated = false;

	const walk = (element: Element, path: string, depth: number): ExtractedNode => {
		budget--;
		const style = getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		const node: ExtractedNode = {
			tag: element.localName,
			path,
			selector: cssPath(element),
			rect: [round(rect.left + scrollX), round(rect.top + scrollY), round(rect.width), round(rect.height)],
			styles: readStyles(style, STYLE_PROPS),
		};
		const own = Array.from(element.childNodes)
			.filter((child) => child.nodeType === Node.TEXT_NODE)
			.map((child) => child.textContent ?? "")
			.join(" ");
		const text = clean(own, 300);
		if (text) node.text = text;
		if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
			// The placeholder is content; what someone typed is not.
			if (element.placeholder) node.text = clean(element.placeholder, 300);
		}
		const attrs: Record<string, string> = {};
		for (const name of ATTRS) {
			const value = element.getAttribute(name);
			if (value !== null) attrs[name] = value.slice(0, 500);
		}
		if (element instanceof HTMLImageElement) {
			attrs.currentSrc = element.currentSrc || element.src;
			attrs.natural = `${element.naturalWidth}x${element.naturalHeight}`;
		}
		if (element instanceof HTMLVideoElement) {
			attrs.currentSrc = element.currentSrc || element.querySelector("source")?.src || "";
			attrs.flags = ["autoplay", "loop", "muted", "playsInline", "controls"]
				.filter((flag) => (element as unknown as Record<string, boolean>)[flag]).join(",");
		}
		if (Object.keys(attrs).length) node.attrs = attrs;
		const hidden = style.display === "none" || style.visibility === "hidden" || (rect.width === 0 && rect.height === 0);
		if (hidden) node.hidden = true;

		for (const which of ["::before", "::after"] as const) {
			const pseudo = getComputedStyle(element, which);
			if (pseudo.content && pseudo.content !== "none" && pseudo.content !== "normal") {
				node.pseudo ??= {};
				node.pseudo[which === "::before" ? "before" : "after"] = readStyles(pseudo, PSEUDO_PROPS);
			}
		}

		if (element.localName === "svg") {
			const markup = element.outerHTML;
			node.svg = markup.length <= SVG_MAX ? markup : `[${markup.length} chars, over ${SVG_MAX}]`;
			return node;
		}
		// A hidden subtree is still recorded — it is often the other state of a
		// menu or tab — but only one level of it.
		const children = Array.from(element.children).filter((child) => !SKIP.has(child.tagName));
		if (!children.length) return node;
		if (depth >= options.maxDepth || (hidden && depth > 0)) {
			node.omitted = children.length;
			truncated = true;
			return node;
		}
		node.children = [];
		for (let index = 0; index < children.length; index++) {
			if (budget <= 0) {
				node.omitted = children.length - index;
				truncated = true;
				break;
			}
			node.children.push(walk(children[index]!, path ? `${path}.${index}` : String(index), depth + 1));
		}
		return node;
	};

	const targets: Record<string, ExtractedNode | { error: string }> = {};
	for (const [name, selector] of Object.entries(options.targets)) {
		let element: Element | null = null;
		try {
			element = document.querySelector(selector);
		} catch (error) {
			targets[name] = { error: `Invalid selector ${selector}: ${(error as Error).message}` };
			continue;
		}
		if (!element) {
			targets[name] = { error: `No element matches ${selector}` };
			continue;
		}
		if (budget <= 0) {
			targets[name] = { error: "Node budget exhausted before this target; extract it separately" };
			truncated = true;
			continue;
		}
		targets[name] = walk(element, "", 0);
	}
	const root = document.documentElement;
	return {
		version: 1,
		url: location.href,
		title: document.title,
		viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
		scroll: { x: scrollX, y: scrollY },
		document: { scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight },
		targets,
		nodes: options.maxNodes - budget,
		truncated,
	} satisfies Extraction;
}

/** The expression `browser_extract` evaluates. */
export function extractionExpression(options: ExtractOptions): string {
	return `(${extractInPage.toString()})(${JSON.stringify(options)})`;
}

// ---------------------------------------------------------------------------
// Comparison

export type MatchMode = "text" | "path";

export interface ComparisonIssue {
	target: string;
	kind: "missing-target" | "target-error" | "rect" | "style" | "missing-text" | "extra-text" | "media" | "count";
	/** Where in the first extraction, when there is a node to point at. */
	at?: string;
	detail: string;
}

export interface Comparison {
	a: string;
	b: string;
	mode: MatchMode;
	tolerancePx: number;
	viewports: { a: string; b: string };
	targets: number;
	issues: ComparisonIssue[];
	counts: Record<ComparisonIssue["kind"], number>;
}

/** The properties that decide how text looks. Compared per matched text node. */
const TEXT_PROPS = [
	"fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "color",
	"textAlign", "textTransform", "textDecorationLine",
];

/** The properties that decide how a box looks. Compared on target roots and path-matched nodes. */
const BOX_PROPS = [
	"display", "position", "zIndex", "maxWidth",
	"paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
	"marginTop", "marginRight", "marginBottom", "marginLeft",
	"flexDirection", "justifyContent", "alignItems", "rowGap", "columnGap", "gridTemplateColumns",
	"backgroundColor", "backgroundImage",
	"borderTopWidth", "borderBottomWidth", "borderTopColor", "borderBottomColor", "borderTopLeftRadius",
	"boxShadow", "opacity", "transform", "filter", "backdropFilter", "overflowX", "overflowY",
	"transitionProperty", "transitionDuration", "transitionTimingFunction",
];

const PX = /^-?\d+(?:\.\d+)?px$/;
const RGB = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/;

/**
 * The family a stack resolves to, comparable across source and clone.
 * `next/font` renames families to `__Inter_a1b2c3` and adds a fallback, so
 * the first family is compared with that wrapping taken off.
 */
export function primaryFontFamily(stack: string): string {
	const first = (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
	const hashed = first.match(/^__(.+?)(?:_Fallback)?_[0-9a-f]{5,}$/i);
	return (hashed ? hashed[1]!.replace(/_/g, " ") : first).toLowerCase();
}

function sameValue(prop: string, a: string | undefined, b: string | undefined, tolerancePx: number): boolean {
	const left = a ?? "";
	const right = b ?? "";
	if (left === right) return true;
	if (prop === "fontFamily") return primaryFontFamily(left) === primaryFontFamily(right);
	// Missing means the extractor dropped a default: zero, none, normal.
	const zeroish = (value: string) => value === "" || value === "0px";
	if (zeroish(left) && zeroish(right)) return true;
	const leftPx = zeroish(left) ? "0px" : left;
	const rightPx = zeroish(right) ? "0px" : right;
	if (PX.test(leftPx) && PX.test(rightPx)) {
		return Math.abs(parseFloat(leftPx) - parseFloat(rightPx)) <= Math.max(0.5, tolerancePx / 4);
	}
	const lc = left.match(RGB);
	const rc = right.match(RGB);
	if (lc && rc) {
		const alpha = (m: RegExpMatchArray) => (m[4] === undefined ? 1 : Number(m[4]));
		return (
			[1, 2, 3].every((i) => Math.abs(Number(lc[i]) - Number(rc[i])) <= 2) &&
			Math.abs(alpha(lc) - alpha(rc)) <= 0.02
		);
	}
	return false;
}

function styleDiffs(
	props: string[],
	a: Record<string, string>,
	b: Record<string, string>,
	tolerancePx: number,
): string[] {
	const diffs: string[] = [];
	for (const prop of props) {
		if (!sameValue(prop, a[prop], b[prop], tolerancePx)) {
			diffs.push(`${prop}: ${a[prop] ?? "(default)"} → ${b[prop] ?? "(default)"}`);
		}
	}
	return diffs;
}

/** ::before/::after that one side draws and the other does not, or draws differently. */
function pseudoDiffs(a: ExtractedNode, b: ExtractedNode, tolerancePx: number): string[] {
	const diffs: string[] = [];
	for (const which of ["before", "after"] as const) {
		const left = a.pseudo?.[which];
		const right = b.pseudo?.[which];
		if (!left && !right) continue;
		if (!left || !right) {
			diffs.push(`::${which}: ${left ? left.content : "(none)"} → ${right ? right.content : "(none)"}`);
			continue;
		}
		for (const diff of styleDiffs(Object.keys({ ...left, ...right }), left, right, tolerancePx)) {
			diffs.push(`::${which} ${diff}`);
		}
	}
	return diffs;
}

function flatten(root: ExtractedNode): ExtractedNode[] {
	const out: ExtractedNode[] = [];
	const visit = (node: ExtractedNode) => {
		out.push(node);
		for (const child of node.children ?? []) visit(child);
	};
	visit(root);
	return out;
}

function relative(node: ExtractedNode, root: ExtractedNode): [number, number, number, number] {
	return [node.rect[0] - root.rect[0], node.rect[1] - root.rect[1], node.rect[2], node.rect[3]];
}

function rectDiff(
	a: [number, number, number, number],
	b: [number, number, number, number],
	tolerancePx: number,
): string | null {
	const names = ["x", "y", "width", "height"];
	const parts = names
		.map((name, i) => (Math.abs(a[i]! - b[i]!) > tolerancePx ? `${name} ${a[i]} → ${b[i]}` : null))
		.filter(Boolean);
	return parts.length ? parts.join(", ") : null;
}

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

function visibleTextNodes(root: ExtractedNode): ExtractedNode[] {
	return flatten(root).filter((node) => node.text && !node.hidden);
}

function mediaNodes(root: ExtractedNode): ExtractedNode[] {
	return flatten(root).filter(
		(node) => !node.hidden && (node.tag === "img" || node.tag === "video" || node.tag === "svg" || node.tag === "picture"),
	);
}

/**
 * Compare two extractions target by target.
 *
 * `text` pairs nodes by their text, in order — for a source page and its clone,
 * whose DOMs differ but whose content should not. `path` pairs nodes by their
 * position in the tree — for two states of the same page (before and after a
 * scroll, hover or click), where the difference *is* the behavior.
 */
export function compareExtractions(
	a: Extraction,
	b: Extraction,
	options: { mode?: MatchMode; tolerancePx?: number; labels?: [string, string] } = {},
): Comparison {
	const mode = options.mode ?? "text";
	const tolerancePx = options.tolerancePx ?? 2;
	const issues: ComparisonIssue[] = [];
	const names = [...new Set([...Object.keys(a.targets), ...Object.keys(b.targets)])];

	for (const name of names) {
		const left = a.targets[name];
		const right = b.targets[name];
		if (!left || !right) {
			issues.push({ target: name, kind: "missing-target", detail: `only in ${left ? "A" : "B"}` });
			continue;
		}
		if ("error" in left || "error" in right) {
			const errors = [
				"error" in left ? `A: ${left.error}` : null,
				"error" in right ? `B: ${right.error}` : null,
			].filter(Boolean);
			issues.push({ target: name, kind: "target-error", detail: errors.join("; ") });
			continue;
		}

		const rootRect = rectDiff(left.rect, right.rect, tolerancePx);
		if (rootRect) issues.push({ target: name, kind: "rect", at: left.selector, detail: `root ${rootRect}` });
		const rootStyles = styleDiffs([...BOX_PROPS, ...TEXT_PROPS], left.styles, right.styles, tolerancePx);
		if (rootStyles.length) issues.push({ target: name, kind: "style", at: left.selector, detail: `root ${rootStyles.join("; ")}` });

		if (mode === "path") {
			const byPath = new Map(flatten(right).map((node) => [node.path, node]));
			for (const node of flatten(left)) {
				if (!node.path) continue;
				const other = byPath.get(node.path);
				if (!other) continue;
				const label = `${node.selector}${node.text ? ` "${node.text.slice(0, 40)}"` : ""}`;
				const moved = rectDiff(node.rect, other.rect, tolerancePx);
				if (moved) issues.push({ target: name, kind: "rect", at: label, detail: moved });
				const diffs = [
					...styleDiffs([...BOX_PROPS, ...TEXT_PROPS], node.styles, other.styles, tolerancePx),
					...pseudoDiffs(node, other, tolerancePx),
				];
				if (node.hidden !== other.hidden) diffs.unshift(`hidden: ${!!node.hidden} → ${!!other.hidden}`);
				if (diffs.length) issues.push({ target: name, kind: "style", at: label, detail: diffs.join("; ") });
			}
			const leftCount = flatten(left).length;
			const rightCount = flatten(right).length;
			if (leftCount !== rightCount) {
				issues.push({ target: name, kind: "count", detail: `nodes ${leftCount} → ${rightCount}` });
			}
			continue;
		}

		// Text mode: pair text nodes in order, so a repeated label pairs with its
		// own occurrence rather than the first one.
		const leftTexts = visibleTextNodes(left);
		const rightTexts = visibleTextNodes(right);
		const used = new Set<number>();
		let cursor = 0;
		for (const node of leftTexts) {
			const text = normalizeText(node.text!);
			let found = rightTexts.findIndex((other, i) => i >= cursor && !used.has(i) && normalizeText(other.text!) === text);
			if (found === -1) found = rightTexts.findIndex((other, i) => !used.has(i) && normalizeText(other.text!) === text);
			const label = `"${text.slice(0, 60)}"`;
			if (found === -1) {
				issues.push({ target: name, kind: "missing-text", at: node.selector, detail: label });
				continue;
			}
			used.add(found);
			cursor = found + 1;
			const other = rightTexts[found]!;
			const diffs = [...styleDiffs(TEXT_PROPS, node.styles, other.styles, tolerancePx), ...pseudoDiffs(node, other, tolerancePx)];
			if (diffs.length) issues.push({ target: name, kind: "style", at: label, detail: diffs.join("; ") });
			const moved = rectDiff(relative(node, left), relative(other, right), tolerancePx);
			if (moved) issues.push({ target: name, kind: "rect", at: label, detail: `relative to target ${moved}` });
		}
		rightTexts.forEach((node, i) => {
			if (!used.has(i)) {
				issues.push({ target: name, kind: "extra-text", at: node.selector, detail: `"${normalizeText(node.text!).slice(0, 60)}"` });
			}
		});

		const leftMedia = mediaNodes(left);
		const rightMedia = mediaNodes(right);
		for (const tag of ["img", "video", "svg", "picture"]) {
			const l = leftMedia.filter((node) => node.tag === tag);
			const r = rightMedia.filter((node) => node.tag === tag);
			if (l.length !== r.length) {
				issues.push({ target: name, kind: "media", detail: `${tag} count ${l.length} → ${r.length}` });
			}
			for (let i = 0; i < Math.min(l.length, r.length); i++) {
				const [lw, lh] = [l[i]!.rect[2], l[i]!.rect[3]];
				const [rw, rh] = [r[i]!.rect[2], r[i]!.rect[3]];
				if (Math.abs(lw - rw) > tolerancePx || Math.abs(lh - rh) > tolerancePx) {
					issues.push({
						target: name,
						kind: "media",
						at: l[i]!.selector,
						detail: `${tag} #${i + 1} size ${lw}x${lh} → ${rw}x${rh}`,
					});
				}
			}
		}
	}

	const counts = {
		"missing-target": 0, "target-error": 0, rect: 0, style: 0,
		"missing-text": 0, "extra-text": 0, media: 0, count: 0,
	} satisfies Comparison["counts"];
	for (const issue of issues) counts[issue.kind]++;
	return {
		a: options.labels?.[0] ?? a.url,
		b: options.labels?.[1] ?? b.url,
		mode,
		tolerancePx,
		viewports: {
			a: `${a.viewport.width}x${a.viewport.height}`,
			b: `${b.viewport.width}x${b.viewport.height}`,
		},
		targets: names.length,
		issues,
		counts,
	};
}

/** The comparison as Markdown, capped for the model's context. */
export function renderComparison(comparison: Comparison, maxIssues = 150): string {
	const lines = [
		`# Comparison (${comparison.mode} match, ±${comparison.tolerancePx}px)`,
		"",
		`- A: ${comparison.a} @ ${comparison.viewports.a}`,
		`- B: ${comparison.b} @ ${comparison.viewports.b}`,
		`- Targets: ${comparison.targets}; issues: ${comparison.issues.length}`,
		`- ${Object.entries(comparison.counts).filter(([, n]) => n).map(([kind, n]) => `${kind} ${n}`).join(", ") || "no differences"}`,
	];
	if (comparison.viewports.a !== comparison.viewports.b) {
		lines.push("", "**Warning:** the two extractions were taken at different viewports.");
	}
	let current = "";
	for (const issue of comparison.issues.slice(0, maxIssues)) {
		if (issue.target !== current) {
			current = issue.target;
			lines.push("", `## ${current}`);
		}
		lines.push(`- [${issue.kind}]${issue.at ? ` ${issue.at}:` : ""} ${issue.detail}`);
	}
	if (comparison.issues.length > maxIssues) {
		lines.push("", `… ${comparison.issues.length - maxIssues} more; pass saveTo to keep the full report.`);
	}
	return lines.join("\n");
}
