import { CHARACTER_STENCIL, CHARACTER_STENCIL_WIDTH, CHARACTER_TONES } from "./characterStencil";

export const PARTICLE_TRAIL_MS = 1000;

/** Map the text stencil onto the existing background grid, preserving its cells. */
export function characterToneAt(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }): number {
  if (bounds.width <= 0 || bounds.height <= 0 || x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) return 0;
  // Interpolate the fine grayscale stencil rather than snapping to a coarse
  // palette block, retaining facial features and smoothing the silhouette edge.
  const col = (x - bounds.x) / bounds.width * CHARACTER_STENCIL_WIDTH - 0.5;
  const row = (y - bounds.y) / bounds.height * CHARACTER_STENCIL.length - 0.5;
  const left = Math.floor(col);
  const top = Math.floor(row);
  const fx = col - left;
  const fy = row - top;
  const sample = (cx: number, cy: number) => {
    const tone = CHARACTER_STENCIL[cy]?.[cx] ?? " ";
    return Math.max(0, CHARACTER_TONES.indexOf(tone)) / (CHARACTER_TONES.length - 1);
  };
  return (sample(left, top) * (1 - fx) + sample(left + 1, top) * fx) * (1 - fy)
    + (sample(left, top + 1) * (1 - fx) + sample(left + 1, top + 1) * fx) * fy;
}

/** Fit in the landing's lower-left corner, with room for narrow/short panes. */
export function characterBounds(width: number, height: number, aspect: number) {
  const margin = Math.min(24, width * 0.05, height * 0.04);
  const h = Math.max(0, Math.min(560, height * 0.8, (width - margin * 2) * 0.86 / aspect));
  return { x: margin, y: height - margin - h, width: h * aspect, height: h };
}

/** A passing wave reveals only the particles it touches, then leaves a fading trail. */
export function particleEnvelope(previous: number, strength: number, deltaMs: number): number {
  return Math.max(Math.max(0, previous - deltaMs / PARTICLE_TRAIL_MS), Math.min(1, strength * 3));
}
