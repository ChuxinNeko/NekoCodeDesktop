import { describe, expect, test } from "bun:test";
import { fitAgentMap, layoutAgentMap, mapConnector, zoomAgentMap, MAP_INITIAL_VIEW, MAP_MAX_SCALE, MAP_MIN_SCALE, MAP_NODE_HEIGHT, MAP_NODE_WIDTH } from "../../../src/renderer/src/lib/agentMapLayout";

describe("staggered vertical agent map geometry", () => {
  test("packs cards by content height and anchors each connector at its own centre", () => {
    const [main, first, second] = layoutAgentMap(["task:a", "task:b"], {}, { main: 124, "task:a": 188, "task:b": 132 });
    expect(main.height).toBe(124);
    expect(first.height).toBe(188);
    expect(first.y).toBe(124 + 32);
    expect(second.y).toBe(124 + 32 + 188 + 32);
    expect(mapConnector(main, first)).toBe("M 24 124 L 24 238 Q 24 250, 36 250 L 56 250");
    const grown = layoutAgentMap(["task:a", "task:b"], {}, { main: 124, "task:a": 240, "task:b": 132 });
    expect(grown[2].y - second.y).toBe(52);
  });

  test("fit uses measured heights rather than the first-paint estimate", () => {
    const nodes = layoutAgentMap(["task:a"], {}, { main: 120, "task:a": 500 });
    const view = fitAgentMap(nodes, 800, 300);
    expect(view.scale).toBeCloseTo(252 / (120 + 32 + 500));
    expect((nodes[1].y + nodes[1].height) * view.scale + view.y).toBeCloseTo(276);
  });

  test("places children below the main agent with alternating indents and no overlaps", () => {
    const [main, first, second, third] = layoutAgentMap(["task:a", "task:b", "task:c"]);
    expect(first.x).toBeGreaterThan(main.x);
    expect(first.y).toBeGreaterThan(main.y + MAP_NODE_HEIGHT);
    expect(second.y).toBeGreaterThan(first.y + MAP_NODE_HEIGHT);
    expect(second.x).toBeGreaterThan(first.x);
    expect(third.x).toBe(first.x);
  });

  test("uses stable IDs for dragged positions even when the list changes", () => {
    const offsets = { "task:a": { x: 70, y: -28 }, main: { x: -20, y: 50 } };
    const nodes = layoutAgentMap(["task:b", "task:a"], offsets);
    const plain = layoutAgentMap(["task:b", "task:a"]);
    expect(nodes[2].x - plain[2].x).toBe(70);
    expect(nodes[2].y - plain[2].y).toBe(-28);
    expect(nodes[0]).toMatchObject({ x: -20, y: 50 });
    expect(nodes[1]).toEqual(plain[1]);
  });

  test("connects the real port positions after either node moves", () => {
    const [main, child] = layoutAgentMap(["task:a"], { main: { x: 32, y: 40 }, "task:a": { x: -500, y: 20 } });
    const path = mapConnector(main, child);
    expect(path.startsWith(`M ${main.x + 24} ${main.y + MAP_NODE_HEIGHT} L `)).toBe(true);
    expect(path.endsWith(`${child.x} ${child.y + MAP_NODE_HEIGHT / 2}`)).toBe(true);
    expect(path).not.toContain("NaN");
  });

  test("zoom preserves the world position under its anchor and clamps the scale", () => {
    const view = { x: -180, y: 37, scale: 0.8 };
    const anchor = { x: 200, y: 100 };
    for (const requested of [0, 0.4, 1.2, 20]) {
      const next = zoomAgentMap(view, requested, anchor);
      expect((anchor.x - next.x) / next.scale).toBeCloseTo((anchor.x - view.x) / view.scale);
      expect((anchor.y - next.y) / next.scale).toBeCloseTo((anchor.y - view.y) / view.scale);
      expect(next.scale).toBeGreaterThanOrEqual(MAP_MIN_SCALE);
      expect(next.scale).toBeLessThanOrEqual(MAP_MAX_SCALE);
    }
  });

  test("fit includes dragged negative coordinates and all six finished nodes in a narrow dock", () => {
    const nodes = layoutAgentMap(Array.from({ length: 6 }, (_, index) => `task:${index}`), { main: { x: -100, y: -50 } });
    const view = fitAgentMap(nodes, 360, 500);
    for (const node of nodes) {
      expect(node.x * view.scale + view.x).toBeGreaterThanOrEqual(23.9);
      expect(node.y * view.scale + view.y).toBeGreaterThanOrEqual(23.9);
      expect((node.x + MAP_NODE_WIDTH) * view.scale + view.x).toBeLessThanOrEqual(336.1);
      expect((node.y + MAP_NODE_HEIGHT) * view.scale + view.y).toBeLessThanOrEqual(476.1);
    }
    expect(fitAgentMap([], 0, 0)).toEqual(MAP_INITIAL_VIEW);
  });
});
