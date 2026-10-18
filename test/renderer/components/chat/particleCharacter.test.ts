import { describe, expect, test } from "bun:test";
import { characterBounds, particleEnvelope, sampleCharacterParticles } from "../../../../src/renderer/src/components/chat/particleCharacter";

describe("home particle character", () => {
  test("omits white and gray background while preserving yellow, dark details and transparency", () => {
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255, 210, 208, 205, 255, 230, 190, 60, 255,
      20, 20, 10, 255, 230, 190, 60, 0, 230, 190, 60, 128,
    ]);
    const points = sampleCharacterParticles(pixels, 3, 2);
    expect(points).toHaveLength(3);
    expect(points[0]!.color).toBe("rgb(230 190 60)");
    expect(points[1]!.color).toBe("rgb(20 20 10)");
    expect(points[2]!.alpha).toBeCloseTo(128 / 255);
    expect(points.every((p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1)).toBe(true);
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
