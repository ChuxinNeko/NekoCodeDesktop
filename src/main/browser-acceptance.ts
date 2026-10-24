export interface BrowserCheckInput {
	title?: string;
	maxHorizontalOverflow?: number;
	elements?: Array<{ selector: string; visible?: boolean; textIncludes?: string; enabled?: boolean; inViewport?: boolean }>;
}

/** Serialized into the actual guest page. No DOM mutations or model-supplied JavaScript. */
export function inspectBrowserAcceptance(input: BrowserCheckInput) {
	const viewport = { width: innerWidth, height: innerHeight };
	const root = document.documentElement;
	const width = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0);
	const horizontalOverflow = Math.max(0, width - root.clientWidth);
	const tolerance = input.maxHorizontalOverflow ?? 1;
	const elements = (input.elements ?? []).map(expected => {
		try {
			const element = document.querySelector(expected.selector);
			if (!element) return { selector: expected.selector, passed: false, error: "Element not found" };
			const bounds = element.getBoundingClientRect();
			const visible = element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && bounds.width > 0 && bounds.height > 0;
			const enabled = !element.matches(':disabled,[aria-disabled="true"]') && !element.closest('[inert]');
			const inViewport = visible && bounds.left >= -tolerance && bounds.right <= innerWidth + tolerance && bounds.top < innerHeight && bounds.bottom > 0;
			const actualText = (element.textContent ?? "").replace(/\s+/g, " ").trim();
			return {
				selector: expected.selector, visible, enabled, inViewport,
				bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
				...(expected.textIncludes !== undefined ? { textMatched: actualText.includes(expected.textIncludes) } : {}),
				passed: visible === (expected.visible ?? true) && (expected.enabled === undefined || enabled === expected.enabled) &&
					(expected.inViewport === undefined || inViewport === expected.inViewport) && (expected.textIncludes === undefined || actualText.includes(expected.textIncludes)),
			};
		} catch (error) { return { selector: expected.selector, passed: false, error: String(error).slice(0, 300) }; }
	});
	const overflowingElements = horizontalOverflow > tolerance ? [...document.querySelectorAll("body *")].slice(0, 3000).flatMap(element => {
		const bounds = element.getBoundingClientRect();
		return bounds.width > 0 && (bounds.left < -tolerance || bounds.right > innerWidth + tolerance) ?
			[{ tag: element.localName, id: element.id.slice(0, 80), left: Math.round(bounds.left), right: Math.round(bounds.right) }] : [];
	}).slice(0, 12) : [];
	return {
		title: input.title || "Page layout and element checks", status: horizontalOverflow <= tolerance && elements.every(element => element.passed) ? "passed" : "failed",
		url: location.href, viewport, horizontalOverflow, tolerance, elements, overflowingElements,
	};
}

export const browserAcceptanceExpression = (input: BrowserCheckInput): string => `(${inspectBrowserAcceptance.toString()})(${JSON.stringify(input)})`;
