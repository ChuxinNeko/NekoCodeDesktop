import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { useTranslation } from "../../i18n";
import { layoutAgentMap, mapConnector, mapConnectionPorts, zoomAgentMap, fitAgentMap, MAP_INITIAL_VIEW, MAP_NODE_WIDTH, MAP_MIN_SCALE, MAP_MAX_SCALE, type MapPoint } from "../../lib/agentMapLayout";
import { Maximize2, MinusIcon, PlusIcon, RotateCcwIcon } from "../../lib/icons";
import { IconButton } from "../ui/icon-button";

export interface AgentMapNode { id: string; label: string; tone: string; content: ReactNode; onOpen?: () => void }

export function AgentMapCanvas({ main, children }: { main: ReactNode; children: readonly AgentMapNode[] }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(MAP_INITIAL_VIEW);
  const [offsets, setOffsets] = useState<Record<string, MapPoint>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const gesture = useRef<{ pointer: number; id: string | null; start: MapPoint; origin: MapPoint; scale: number; moved: boolean } | null>(null);
  const positions = useMemo(() => layoutAgentMap(children.map(node => node.id), offsets, heights), [children, offsets, heights]);
  const root = positions[0];
  const nodeIds = JSON.stringify(children.map(node => node.id));

  // offsetHeight is in canvas units, so zooming cannot distort card measurements.
  useLayoutEffect(() => {
    const elements = container.current?.querySelectorAll<HTMLElement>("[data-map-node]");
    if (!elements) return;
    const measure = () => {
      const next: Record<string, number> = {};
      elements.forEach(element => { if (element.offsetHeight > 0) next[element.dataset.mapNode!] = element.offsetHeight; });
      setHeights(current => Object.keys(current).length === Object.keys(next).length && Object.keys(next).every(id => current[id] === next[id]) ? current : next);
    };
    const observer = new ResizeObserver(measure);
    elements.forEach(element => observer.observe(element));
    measure();
    return () => observer.disconnect();
  }, [nodeIds]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        setView(current => zoomAgentMap(current, current.scale * Math.exp(-event.deltaY * 0.005), { x: event.clientX - rect.left, y: event.clientY - rect.top }));
      } else {
        setView(current => ({ ...current, x: current.x - (event.shiftKey ? event.deltaY : event.deltaX), y: current.y - (event.shiftKey ? event.deltaX : event.deltaY) }));
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const zoom = (factor: number) => {
    const element = container.current;
    if (element) setView(current => zoomAgentMap(current, current.scale * factor, { x: element.clientWidth / 2, y: element.clientHeight / 2 }));
  };
  const fit = () => {
    const element = container.current;
    if (element) setView(fitAgentMap(positions, element.clientWidth, element.clientHeight));
  };
  const reset = () => { setOffsets({}); setView({ ...MAP_INITIAL_VIEW }); };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gesture.current || (event.target as HTMLElement).closest("button, a, input, textarea")) return;
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-map-node]")?.dataset.mapNode ?? null;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, id, start: { x: event.clientX, y: event.clientY }, origin: id ? offsets[id] ?? { x: 0, y: 0 } : { x: view.x, y: view.y }, scale: view.scale, moved: false };
    setDragging(id ?? "canvas");
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (Math.hypot(dx, dy) > 4) current.moved = true;
    if (!current.moved) return;
    if (current.id) {
      setOffsets(previous => ({ ...previous, [current.id!]: { x: current.origin.x + dx / current.scale, y: current.origin.y + dy / current.scale } }));
    } else setView(previous => ({ ...previous, x: current.origin.x + dx, y: current.origin.y + dy }));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current?.pointer !== event.pointerId) return;
    gesture.current = null;
    setDragging(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === "pointerup" && !current.moved && current.id) children.find(node => node.id === current.id)?.onOpen?.();
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div ref={container} className="agent-map-canvas absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" role="region" aria-label={t("agentMap.canvas")} tabIndex={0}
        data-dragging={dragging !== null || undefined} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          const delta: Record<string, MapPoint> = { ArrowLeft: { x: 48, y: 0 }, ArrowRight: { x: -48, y: 0 }, ArrowUp: { x: 0, y: 48 }, ArrowDown: { x: 0, y: -48 } };
          if (delta[event.key]) { event.preventDefault(); setView(current => ({ ...current, x: current.x + delta[event.key].x, y: current.y + delta[event.key].y })); }
          else if (["+", "=", "-", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            if (event.key === "Home") reset(); else if (event.key === "End") fit(); else zoom(event.key === "-" ? 1 / 1.2 : 1.2);
          }
        }}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden="true">
            {children.map((node, index) => {
              const ports = mapConnectionPorts(root, positions[index + 1]);
              return <g key={node.id} className="agent-map-edge" data-tone={node.tone}>
              <path d={mapConnector(root, positions[index + 1])} fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx={ports.start.x} cy={ports.start.y} r="4" />
              <circle cx={ports.end.x} cy={ports.end.y} r="4" />
            </g>;
            })}
          </svg>
          {positions.map((position, index) => {
            const label = index === 0 ? t("agentMap.main") : children[index - 1].label;
            const onOpen = index === 0 ? undefined : children[index - 1].onOpen;
            return <div key={position.id} data-map-node={position.id} className="agent-map-node absolute rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} role={onOpen ? "button" : "group"} aria-label={t(onOpen ? "agentMap.openNode" : "agentMap.moveNode", { name: label })}
              style={{ left: position.x, top: position.y, width: MAP_NODE_WIDTH, zIndex: dragging === position.id ? 2 : 1 }}
              onClick={event => { if (event.detail === 0) onOpen?.(); }}
              onKeyDown={event => {
                if (event.target === event.currentTarget && onOpen && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault(); event.stopPropagation(); onOpen(); return;
                }
                if (event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const step = event.shiftKey ? 32 : 10;
                setOffsets(previous => ({ ...previous, [position.id]: { x: (previous[position.id]?.x ?? 0) + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), y: (previous[position.id]?.y ?? 0) + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) } }));
              }}>
              {index === 0 ? main : children[index - 1].content}
            </div>;
          })}
        </div>
      </div>
      <div className="agent-map-controls absolute bottom-3 right-3 flex items-center gap-0.5 rounded-xl border border-[color:var(--app-surface-divider)] p-1 shadow-sm" role="group" aria-label={t("agentMap.viewControls")}>
        <IconButton label={t("agentMap.zoomOut")} title={t("agentMap.zoomOut")} disabled={view.scale <= MAP_MIN_SCALE} onClick={() => zoom(1 / 1.2)}><MinusIcon /></IconButton>
        <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(view.scale * 100)}%</span>
        <IconButton label={t("agentMap.zoomIn")} title={t("agentMap.zoomIn")} disabled={view.scale >= MAP_MAX_SCALE} onClick={() => zoom(1.2)}><PlusIcon /></IconButton>
        <span className="mx-1 h-4 border-l border-[color:var(--app-surface-divider)]" />
        <IconButton label={t("agentMap.fit")} title={t("agentMap.fit")} onClick={fit}><Maximize2 /></IconButton>
        <IconButton label={t("agentMap.reset")} title={t("agentMap.reset")} onClick={reset}><RotateCcwIcon /></IconButton>
      </div>
    </div>
  );
}
