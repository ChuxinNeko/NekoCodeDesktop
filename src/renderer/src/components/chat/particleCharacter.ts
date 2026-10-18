export const PARTICLE_TRAIL_MS = 1000;

export interface CharacterParticle {
  x: number;
  y: number;
  color: string;
  alpha: number;
}

/** Sample the supplied artwork, omitting its white backdrop and neutral floor shadow. */
export function sampleCharacterParticles(data: Uint8ClampedArray, width: number, height: number): CharacterParticle[] {
  const particles: CharacterParticle[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
      const min = Math.min(r, g, b);
      if (a < 32 || (min > 145 && Math.max(r, g, b) - min < 40)) continue;
      particles.push({ x: (x + 0.5) / width, y: (y + 0.5) / height, color: `rgb(${r} ${g} ${b})`, alpha: a / 255 });
    }
  }
  return particles;
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
