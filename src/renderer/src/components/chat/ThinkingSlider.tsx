// FILE: ThinkingSlider.tsx
// Purpose: Gradient pill slider for the thinking level, shown at the bottom of the model picker.
// Layer: Composer picker presentation
// Behavior: discrete stops (dots), white round thumb, drag/click/keyboard; LED-matrix twinkle plus right-to-left ripples inside the track at the max stop.

import { useCallback, useEffect, useRef } from "react";
import type { ThinkingLevel } from "../../../../shared/agent";
import { cn } from "../../lib/utils";

const TRACK_HEIGHT = 26;
/** LED-matrix cell pitch in CSS px: 4px cell + 1px gap gives 5 rows on the 26px track. */
const CELL = 5;
const GAP = 1;
/** Ripple radiating right to left from the thumb: px/s, band width px, lifetime s. */
const WAVE_SPEED = 140;
const WAVE_WIDTH = 13;
const WAVE_LIFE = 1.4;

interface Cell {
	level: number;
	target: number;
	next: number;
}

interface ThinkingSliderProps {
	levels: ThinkingLevel[];
	value: ThinkingLevel;
	onChange: (level: ThinkingLevel) => void;
	disabled?: boolean;
	ariaLabel: string;
	valueText: (level: ThinkingLevel) => string;
}

export function ThinkingSlider({ levels, value, onChange, disabled, ariaLabel, valueText }: ThinkingSliderProps) {
	const trackRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const raf = useRef<number | null>(null);
	const draggingRef = useRef(false);
	const lastTime = useRef(0);
	const energy = useRef(0);
	const cells = useRef<Cell[]>([]);
	const grid = useRef({ cols: 0, rows: 0 });
	/** Ages (seconds) of live ripples radiating from the thumb toward the left. */
	const waves = useRef<number[]>([]);
	const nextWave = useRef(0);

	const count = levels.length;
	const index = Math.max(0, levels.indexOf(value));
	const ratio = count > 1 ? index / (count - 1) : 0;
	const atMax = count > 1 && index === count - 1;
	const atMaxRef = useRef(atMax);
	atMaxRef.current = atMax;
	const reducedMotion = useRef(false);

	useEffect(() => {
		reducedMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	}, []);

	const frame = useCallback((now: number) => {
		const canvas = canvasRef.current;
		const track = trackRef.current;
		if (!canvas || !track) { raf.current = null; return; }
		const dt = Math.min(0.05, (now - (lastTime.current || now)) / 1000);
		lastTime.current = now;
		const dpr = window.devicePixelRatio || 1;
		const w = track.clientWidth;
		const h = TRACK_HEIGHT;
		if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
		}
		const cols = Math.floor((w + GAP) / CELL);
		const rows = Math.floor((h + GAP) / CELL);
		if (grid.current.cols !== cols || grid.current.rows !== rows) {
			grid.current = { cols, rows };
			cells.current = Array.from({ length: cols * rows }, () => ({ level: 0, target: 0, next: 0 }));
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) { raf.current = null; return; }
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		// Energy ramps up while at max and bleeds off afterwards, so the LEDs fade in/out.
		const goal = atMaxRef.current && !reducedMotion.current ? 1 : 0;
		energy.current += (goal - energy.current) * Math.min(1, dt * (goal ? 3 : 6));
		if (energy.current < 0.01 && goal === 0) energy.current = 0;

		if (goal) {
			nextWave.current -= dt;
			if (nextWave.current <= 0) { waves.current.push(0); nextWave.current = 2.2; }
		}
		for (let i = 0; i < waves.current.length; i++) waves.current[i]! += dt;
		waves.current = waves.current.filter((age) => age < WAVE_LIFE);
		// Ripple origin is the thumb centre at the max end of the track.
		const originX = w - TRACK_HEIGHT / 2;
		const originY = h / 2;

		const offX = (w - (cols * CELL - GAP)) / 2;
		const offY = (h - (rows * CELL - GAP)) / 2;
		const size = CELL - GAP;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const cell = cells.current[r * cols + c]!;
				const x = cols > 1 ? c / (cols - 1) : 0;
				// Brighter and denser toward the right, like the reference: faint on the left, busy at the max end.
				const density = Math.max(0, (x - 0.18) / 0.82) ** 1.3;
				cell.next -= dt;
				if (cell.next <= 0) {
					cell.next = 0.12 + Math.random() * 0.55;
					cell.target = Math.random() < 0.35 + density * 0.6 ? (0.25 + Math.random() * 0.75) * (0.35 + density * 0.65) : 0;
				}
				cell.level += (cell.target - cell.level) * Math.min(1, dt * 9);
				let ring = 0;
				if (waves.current.length) {
					const dist = Math.hypot(offX + c * CELL + size / 2 - originX, offY + r * CELL + size / 2 - originY);
					for (const age of waves.current) {
						const radius = age * WAVE_SPEED;
						const d = (dist - radius) / WAVE_WIDTH;
						// Bright leading edge with a short trailing glow behind it.
						const falloff = 1 - age / WAVE_LIFE;
						ring = Math.max(ring, (d > 0 ? Math.exp(-d * d * 3) : Math.exp(d * 0.7)) * falloff);
					}
				}
				const alpha = Math.min(0.95, (0.05 + cell.level * 0.5) * energy.current + ring * 0.75 * energy.current);
				if (alpha < 0.01) continue;
				ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
				ctx.fillRect(offX + c * CELL, offY + r * CELL, size, size);
			}
		}
		if (energy.current > 0 || goal) {
			raf.current = requestAnimationFrame(frame);
		} else {
			raf.current = null;
			lastTime.current = 0;
			ctx.clearRect(0, 0, w, h);
		}
	}, []);

	useEffect(() => {
		if (atMax) nextWave.current = 0;
		if (atMax && raf.current === null) raf.current = requestAnimationFrame(frame);
	}, [atMax, frame]);

	useEffect(() => () => {
		if (raf.current !== null) cancelAnimationFrame(raf.current);
		raf.current = null;
	}, []);

	const pick = (clientX: number) => {
		const track = trackRef.current;
		if (!track || count < 2) return;
		const rect = track.getBoundingClientRect();
		const usable = Math.max(1, rect.width - TRACK_HEIGHT);
		const r = Math.min(1, Math.max(0, (clientX - rect.left - TRACK_HEIGHT / 2) / usable));
		const next = levels[Math.round(r * (count - 1))];
		if (next && next !== value) onChange(next);
	};

	return (
		<div className="relative">
			<div
				ref={trackRef}
				role="slider"
				tabIndex={disabled ? -1 : 0}
				aria-label={ariaLabel}
				aria-valuemin={0}
				aria-valuemax={Math.max(0, count - 1)}
				aria-valuenow={index}
				aria-valuetext={valueText(value)}
				aria-disabled={disabled || undefined}
				onPointerDown={(event) => {
					if (disabled) return;
					draggingRef.current = true;
					event.currentTarget.setPointerCapture(event.pointerId);
					pick(event.clientX);
				}}
				onPointerMove={(event) => { if (draggingRef.current) pick(event.clientX); }}
				onPointerUp={(event) => {
					draggingRef.current = false;
					event.currentTarget.releasePointerCapture?.(event.pointerId);
				}}
				onPointerCancel={() => { draggingRef.current = false; }}
				onKeyDown={(event) => {
					if (disabled) return;
					const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1
						: event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
					const target = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : index + step;
					if (step === 0 && event.key !== "Home" && event.key !== "End") return;
					event.preventDefault();
					event.stopPropagation();
					const next = levels[Math.min(count - 1, Math.max(0, target))];
					if (next) onChange(next);
				}}
				className={cn(
					"relative z-0 w-full touch-none overflow-hidden select-none rounded-full outline-none",
					"focus-visible:ring-2 focus-visible:ring-[#a855f7]/50",
					disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
				)}
				style={{
					height: TRACK_HEIGHT,
					background: "linear-gradient(90deg, #6a6df5 0%, #8e5df3 55%, #b24ef0 100%)",
				}}
			>
				<canvas
					ref={canvasRef}
					aria-hidden
					className="pointer-events-none absolute inset-0 size-full"
				/>
				{levels.map((level, i) => (
					<span
						key={level}
						aria-hidden
						className="pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/75"
						style={{ left: `calc(${TRACK_HEIGHT / 2}px + (100% - ${TRACK_HEIGHT}px) * ${count > 1 ? i / (count - 1) : 0})` }}
					/>
				))}
				<span
					aria-hidden
					className="pointer-events-none absolute top-0 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.35)] transition-[left] duration-150 ease-out motion-reduce:transition-none"
					style={{
						width: TRACK_HEIGHT,
						height: TRACK_HEIGHT,
						left: `calc((100% - ${TRACK_HEIGHT}px) * ${ratio})`,
					}}
				/>
			</div>
		</div>
	);
}
