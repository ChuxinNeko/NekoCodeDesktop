import { CHARACTER_STENCIL, CHARACTER_STENCIL_WIDTH, CHARACTER_TONES } from "./characterStencil";

export const PARTICLE_TRAIL_MS = 1000;

/** Map the text stencil onto the existing background grid, preserving its cells. */
export function characterToneAt(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }): number {
  if (bounds.width <= 0 || bounds.height <= 0 || x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) return 0;
  const col = Math.floor((x - bounds.x) / bounds.width * CHARACTER_STENCIL_WIDTH);
  const row = Math.floor((y - bounds.y) / bounds.height * CHARACTER_STENCIL.length);
  const tone = CHARACTER_STENCIL[row]?.[col] ?? " ";
  return Math.max(0, CHARACTER_TONES.indexOf(tone));
}

/** Fit in the landing's lower-left corner, with room for narrow/short panes. */
export function characterBounds(width: number, height: number, aspect: number, availableHeight = Infinity) {
  const margin = Math.min(24, width * 0.05, height * 0.04);
  const h = Math.max(0, Math.min(330, height * 0.48, (width - margin * 2) / aspect, availableHeight));
  return { x: margin, y: height - margin - h, width: h * aspect, height: h };
}

/** A passing wave reveals only the particles it touches, then leaves a fading trail. */
export function particleEnvelope(previous: number, strength: number, deltaMs: number): number {
  return Math.max(Math.max(0, previous - deltaMs / PARTICLE_TRAIL_MS), Math.min(1, strength * 3));
}
