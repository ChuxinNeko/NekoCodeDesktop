import { describe, expect, test } from "bun:test";
import { characterBounds, characterToneAt, particleEnvelope } from "../../../../src/renderer/src/components/chat/particleCharacter";

describe("home particle character", () => {
  test("maps only the character silhouette into the background's existing cell positions", () => {
    const bounds = { x: 24, y: 100, width: 200, height: 330 };
    expect(characterToneAt(24, 100, bounds)).toBe(0);
    expect(characterToneAt(124, 265, bounds)).toBeGreaterThan(0);
    for (const [x, y] of [[23, 260], [225, 260], [124, 99], [124, 431]]) {
      expect(characterToneAt(x!, y!, bounds)).toBe(0);
    }
    expect(characterToneAt(0, 0, { x: 0, y: 0, width: 0, height: 0 })).toBe(0);
    // Resizing changes the mapping, not the character's relative shape.
    const smaller = { x: 40, y: 200, width: 100, height: 165 };
    expect(characterToneAt(90, 282.5, smaller)).toBe(characterToneAt(124, 265, bounds));
  });

  test("remains hidden until the wave reaches a particle and fades after it passes", () => {
    expect(particleEnvelope(0, 0, 100)).toBe(0);
    const touched = particleEnvelope(0, 0.5, 25);
    expect(touched).toBe(1);
    expect(particleEnvelope(touched, 0, 500)).toBe(0.5);
    expect(particleEnvelope(touched, 0, 1100)).toBe(0);
    expect(particleEnvelope(0.2, 0.3, 25)).toBeCloseTo(0.9);
  });

  test("fits the lower-left corner in desktop, narrow, and short layouts", () => {
    expect(characterBounds(500, 720, 583 / 927, 140).height).toBe(140);
    expect(characterBounds(500, 280, 583 / 927, -20).height).toBe(0);
    for (const [width, height] of [[1200, 900], [280, 600], [600, 280], [0, 0]]) {
      const rect = characterBounds(width!, height!, 583 / 927);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width!);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height!);
      expect(rect.height).toBeLessThanOrEqual(330);
    }
  });
});
