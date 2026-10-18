import type { CSSProperties } from "react";

interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SelectionActionsPosition {
  left: number;
  top: number;
}

/** All measurements use viewport coordinates, as does the fixed-position bar. */
export function selectionActionsPosition({
  rects, selectionLeft, pointerOffsetX, menuWidth, menuHeight, viewportWidth, viewportHeight,
}: {
  rects: readonly SelectionRect[];
  selectionLeft: number;
  /** Mouse release X relative to the range, so scrolling keeps the same anchor. */
  pointerOffsetX?: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): SelectionActionsPosition | null {
  const lastLine = rects.filter(rect => rect.width > 0 && rect.height > 0).at(-1);
  if (!lastLine || menuWidth <= 0 || menuHeight <= 0) return null;
  const gap = 8;
  const x = pointerOffsetX === undefined ? (lastLine.left + lastLine.right) / 2 : selectionLeft + pointerOffsetX;
  const clamp = (value: number, size: number, viewport: number) => Math.max(gap, Math.min(value, viewport - size - gap));
  const below = lastLine.bottom + gap;
  const top = below + menuHeight <= viewportHeight - gap ? below : lastLine.top - menuHeight - gap;
  return {
    left: clamp(x - menuWidth / 2, menuWidth, viewportWidth),
    top: clamp(top, menuHeight, viewportHeight),
  };
}

/** No visible origin frame and no positional transition, including on re-anchor. */
export function selectionActionsPositionStyle(position: SelectionActionsPosition | null): CSSProperties {
  return {
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    visibility: position ? "visible" : "hidden",
    opacity: position ? 1 : 0,
    pointerEvents: position ? "auto" : "none",
    transition: "opacity 180ms ease-out",
  };
}
