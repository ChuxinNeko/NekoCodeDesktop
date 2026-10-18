import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SelectionActions from "../../../src/renderer/src/components/primitives/SelectionActions";
import { selectionActionsPosition, selectionActionsPositionStyle } from "../../../src/renderer/src/lib/selectionActionsPosition";

function rect(left: number, top: number, width: number, height = 20) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}
const base = {
  rects: [rect(350, 240, 400), rect(350, 260, 200)],
  selectionLeft: 350, pointerOffsetX: 180,
  menuWidth: 360, menuHeight: 36, viewportWidth: 1200, viewportHeight: 800,
};

describe("selection actions first visible position", () => {
  test("the actual menu mounts hidden, with opacity as its only position-layer transition", () => {
    // No DOM measurements exist during this initial render.
    const html = renderToStaticMarkup(createElement(SelectionActions, {
      range: {} as Range,
      actionLabels: { explain: "Explain", improve: "Improve", shorten: "Shorten", tone: "Tone", grammar: "Grammar" },
      labels: { keep: "Keep", discard: "Discard", placeholder: "Instruction", retry: "Retry", more: "More", fewer: "Fewer", send: "Send", editing: "Sending", copy: "Copy", error: "Error" },
      onAction: () => {}, onCopy: async () => {},
    }));
    const layer = html.match(/<div data-selection-actions-menu=""[^>]*>/)?.[0];
    expect(layer).toBeDefined();
    expect(layer).toContain("visibility:hidden");
    expect(layer).toContain("opacity:0");
    expect(layer).toContain("transition:opacity 180ms ease-out");
    expect(layer).not.toContain("transform");
  });

  test("stays hidden until measured, then appears under the last line near mouse release", () => {
    expect(selectionActionsPositionStyle(null)).toMatchObject({ visibility: "hidden", opacity: 0, pointerEvents: "none" });
    const position = selectionActionsPosition(base);
    expect(position).toEqual({ left: 350, top: 288 });
    const firstVisible = selectionActionsPositionStyle(position);
    expect(firstVisible).toMatchObject({ left: 350, top: 288, visibility: "visible", opacity: 1 });
    expect(firstVisible.transition).toBe("opacity 180ms ease-out");
    expect(firstVisible.transform).toBeUndefined();
    expect(firstVisible.transition).not.toMatch(/transform|left|top|all/);
  });

  test("width changes and a new selection use their actual coordinates without translation", () => {
    const expanded = selectionActionsPosition({ ...base, menuWidth: 600 });
    expect(expanded).toEqual({ left: 230, top: 288 });
    const moved = selectionActionsPosition({ ...base, rects: [rect(700, 450, 100)], selectionLeft: 700, pointerOffsetX: 90 });
    expect(moved).toEqual({ left: 610, top: 478 });
    expect(selectionActionsPositionStyle(moved).transition).toBe("opacity 180ms ease-out");
  });

  test("scrolling retains the mouse's offset within the selection", () => {
    expect(selectionActionsPosition({ ...base, rects: [rect(300, 140, 400), rect(300, 160, 200)], selectionLeft: 300 })).toEqual({ left: 300, top: 188 });
  });

  test("keyboard selection uses the last nonempty line without requiring a mouse", () => {
    expect(selectionActionsPosition({ ...base, pointerOffsetX: undefined, rects: [...base.rects, rect(550, 280, 0)] })).toEqual({ left: 270, top: 288 });
    expect(selectionActionsPosition({ ...base, rects: [] })).toBeNull();
    expect(selectionActionsPositionStyle(selectionActionsPosition({ ...base, menuWidth: 0 })).visibility).toBe("hidden");
  });

  test("clamps both viewport edges and places above when there is no room below", () => {
    for (const left of [-100, 0, 1150, 1300]) {
      for (const top of [-50, 5, 740, 900]) {
        const position = selectionActionsPosition({ ...base, rects: [rect(left, top, 100)], selectionLeft: left, pointerOffsetX: 100 })!;
        expect(position.left).toBeGreaterThanOrEqual(8);
        expect(position.left + base.menuWidth).toBeLessThanOrEqual(base.viewportWidth - 8);
        expect(position.top).toBeGreaterThanOrEqual(8);
        expect(position.top + base.menuHeight).toBeLessThanOrEqual(base.viewportHeight - 8);
      }
    }
    expect(selectionActionsPosition({ ...base, rects: [rect(350, 750, 200)] })?.top).toBe(706);
  });
});
