/** Lazy and serialized: Mermaid has global configuration and a shared render queue. */
let library: Promise<typeof import("mermaid")["default"]> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;
export const MAX_DIAGRAM_LENGTH = 30_000;

/** Fit both axes without stretching small diagrams into oversized labels. */
export function diagramDisplayWidth(svg: string, availableWidth: number): number {
	const box = /viewBox=["']([^"']+)["']/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
	const width = box?.[2];
	const height = box?.[3];
	const available = Math.max(1, availableWidth - 32);
	return width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
		? Math.min(width, available, 448 * width / height) : available;
}

export function renderMermaid(source: string, dark: boolean, current: () => boolean = () => true): Promise<string | null> {
	if (source.length > MAX_DIAGRAM_LENGTH) return Promise.reject(new Error("Diagram is too large"));
	const result = queue.then(async () => {
		if (!current()) return null;
		library ??= import("mermaid").then(module => module.default).catch(error => { library = undefined; throw error; });
		const mermaid = await library;
		if (!current()) return null;
		mermaid.initialize({
			startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
			theme: dark ? "dark" : "default", fontFamily: "sans-serif", htmlLabels: false,
			maxTextSize: MAX_DIAGRAM_LENGTH, maxEdges: 300,
			secure: ["secure", "securityLevel", "startOnLoad", "suppressErrorRendering", "maxTextSize", "maxEdges", "htmlLabels", "theme", "themeVariables", "flowchart"],
			flowchart: { htmlLabels: false },
		});
		const { svg } = await mermaid.render(`neko-diagram-${++sequence}`, source);
		return svg;
	});
	queue = result.catch(() => {});
	return result;
}
