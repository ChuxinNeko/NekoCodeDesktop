export interface MapPoint { x: number; y: number }
export interface MapViewport extends MapPoint { scale: number }
export interface MapNodeBounds extends MapPoint { height?: number }
export const MAP_NODE_WIDTH = 288;
/** First-paint estimate, replaced by each card's measured content height. */
export const MAP_NODE_HEIGHT = 160;
export const MAP_ROW_GAP = 32;
export const MAP_CHILD_INDENT = 56;
export const MAP_STAGGER = 24;
export const MAP_MIN_SCALE = 0.1;
export const MAP_MAX_SCALE = 1.5;
export const MAP_INITIAL_VIEW: MapViewport = { x: 24, y: 32, scale: 0.85 };

/** Positions are keyed by stable run IDs, so live updates preserve dragged nodes. */
export function layoutAgentMap(ids: readonly string[], offsets: Readonly<Record<string, MapPoint>> = {}, heights: Readonly<Record<string, number>> = {}) {
  let nextY = 0;
  return ["main", ...ids].map((id, index) => {
    const height = heights[id] ?? MAP_NODE_HEIGHT;
    const y = nextY;
    nextY += height + MAP_ROW_GAP;
    return {
      id,
      height,
      x: (index === 0 ? 0 : MAP_CHILD_INDENT + ((index - 1) % 2) * MAP_STAGGER) + (offsets[id]?.x ?? 0),
      y: y + (offsets[id]?.y ?? 0),
    };
  });
}

export function mapConnectionPorts(from: MapNodeBounds, to: MapNodeBounds) {
  return {
    start: { x: from.x + 24, y: from.y + (from.height ?? MAP_NODE_HEIGHT) },
    end: { x: to.x, y: to.y + (to.height ?? MAP_NODE_HEIGHT) / 2 },
  };
}

export function mapConnector(from: MapNodeBounds, to: MapNodeBounds): string {
  const { start, end } = mapConnectionPorts(from, to);
  const directionX = Math.sign(end.x - start.x) || 1;
  const directionY = Math.sign(end.y - start.y) || 1;
  const bend = Math.min(12, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2);
  return `M ${start.x} ${start.y} L ${start.x} ${end.y - directionY * bend} Q ${start.x} ${end.y}, ${start.x + directionX * bend} ${end.y} L ${end.x} ${end.y}`;
}

/** Zoom around a cursor or the view centre without moving the point under it. */
export function zoomAgentMap(view: MapViewport, scale: number, anchor: MapPoint): MapViewport {
  const next = Math.min(MAP_MAX_SCALE, Math.max(MAP_MIN_SCALE, scale));
  const ratio = next / view.scale;
  return { x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio, scale: next };
}

export function fitAgentMap(nodes: readonly MapNodeBounds[], width: number, height: number): MapViewport {
  if (!nodes.length || width <= 0 || height <= 0) return { ...MAP_INITIAL_VIEW };
  const left = Math.min(...nodes.map(node => node.x));
  const top = Math.min(...nodes.map(node => node.y));
  const right = Math.max(...nodes.map(node => node.x + MAP_NODE_WIDTH));
  const bottom = Math.max(...nodes.map(node => node.y + (node.height ?? MAP_NODE_HEIGHT)));
  const scale = Math.max(MAP_MIN_SCALE, Math.min(1, (width - 48) / (right - left), (height - 48) / (bottom - top)));
  return { x: (width - (right - left) * scale) / 2 - left * scale, y: (height - (bottom - top) * scale) / 2 - top * scale, scale };
}
