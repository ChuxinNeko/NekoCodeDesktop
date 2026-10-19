import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { useTheme } from "../../hooks/useTheme";
import { diagramDisplayWidth, renderMermaid } from "../../lib/mermaid";
import { Button } from "../ui/button";
import { useElementWidth } from "../review/hooks";

export function MermaidDiagram({ source, streaming = false }: { source: string; streaming?: boolean }) {
	const { t } = useTranslation();
	const { resolvedTheme } = useTheme();
	const root = useRef<HTMLElement>(null);
	const width = useElementWidth(root);
	const [visible, setVisible] = useState(false);
	const [showSource, setShowSource] = useState(false);
	const [zoom, setZoom] = useState(1);
	const [result, setResult] = useState<{ source: string; theme: string; svg?: string; error?: boolean } | null>(null);
	useEffect(() => {
		if (!root.current) return;
		if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
		const observer = new IntersectionObserver(entries => {
			if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
		}, { rootMargin: "200px" });
		observer.observe(root.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (!visible || streaming) return;
		let cancelled = false;
		setZoom(1);
		void renderMermaid(source, resolvedTheme === "dark", () => !cancelled).then(svg => {
			if (!cancelled && svg) setResult({ source, theme: resolvedTheme, svg });
		}).catch(() => {
			if (!cancelled) setResult({ source, theme: resolvedTheme, error: true });
		});
		return () => { cancelled = true; };
	}, [source, resolvedTheme, visible, streaming]);
	const current = result?.source === source && result.theme === resolvedTheme && !streaming ? result : null;
	return <figure ref={root} className="my-3 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background" data-slot="mermaid-diagram">
		<figcaption className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5 text-[12px]">
			<span className="mr-auto font-medium">{t("diagram.title")}</span>
			<Button size="xs" variant="ghost" aria-label={t("diagram.zoomOut")} disabled={zoom <= 0.5 || !current?.svg || showSource} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}>−</Button>
			<Button size="xs" variant="ghost" aria-label={t("common.reset")} disabled={showSource || !current?.svg} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
			<Button size="xs" variant="ghost" aria-label={t("diagram.zoomIn")} disabled={zoom >= 3 || !current?.svg || showSource} onClick={() => setZoom(value => Math.min(3, value + 0.25))}>+</Button>
			<Button size="xs" variant="ghost" aria-pressed={showSource} onClick={() => setShowSource(value => !value)}>{t(showSource ? "diagram.showDiagram" : "diagram.showSource")}</Button>
		</figcaption>
		{showSource || current?.error ? <>
			{current?.error ? <p role="status" className="px-3 pt-3 text-[12px] text-muted-foreground">{t("diagram.error")}</p> : null}
			<pre className="m-0 max-h-[32rem] overflow-auto rounded-none border-0"><code>{source}</code></pre>
		</> : current?.svg ? <div className="max-h-[36rem] overflow-auto overscroll-contain p-4">
			{/* An SVG image cannot execute callbacks in the application's document. */}
			<img alt={t("diagram.title")} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(current.svg)}`} className="mx-auto block max-w-none" style={{ width: diagramDisplayWidth(current.svg, width) * zoom }} />
		</div> : <p role="status" className="p-4 text-[12px] text-muted-foreground">{t(streaming ? "diagram.streaming" : "diagram.loading")}</p>}
	</figure>;
}
