// FILE: diff-stat.tsx
// Purpose: Single source of truth for the "+insertions −deletions" pair rendered
//          wherever the app surfaces diff size (git dialogs, environment panel,
//          branch selector, chat header).
// Layer: UI primitive

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Each decimal column rolls independently; right-aligned keys survive carries. */
function RollingNumber({ value }: { value: number }) {
  const characters = value.toLocaleString().split("");
  return <span aria-label={value.toLocaleString()} className="inline-flex">
    {characters.map((character, index) => /\d/.test(character) ? (
      <span aria-hidden="true" key={characters.length - index} className="relative inline-block h-[1em] w-[1ch] overflow-hidden align-baseline">
        <span className="absolute inset-x-0 top-0 flex flex-col motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out"
          style={{ transform: `translateY(-${Number(character) * 10}%)` }}>
          {Array.from({ length: 10 }, (_, digit) => <span key={digit} className="h-[1em] leading-none">{digit}</span>)}
        </span>
      </span>
    ) : <span aria-hidden="true" key={characters.length - index}>{character}</span>)}
  </span>;
}

export function DiffStat({
  insertions,
  deletions,
  separator,
  className,
  animate = false,
}: {
  insertions: number;
  deletions: number;
  /** Rendered between the two counts — e.g. a "/" in dense file rows. */
  separator?: ReactNode;
  className?: string;
  /** Rolling digits for the live work-log counters. */
  animate?: boolean;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 tabular-nums", className)}
      data-slot="diff-stat"
    >
      <span className="inline-flex items-baseline text-success">+{animate ? <RollingNumber value={insertions} /> : insertions.toLocaleString()}</span>
      {separator}
      <span className="inline-flex items-baseline text-destructive">−{animate ? <RollingNumber value={deletions} /> : deletions.toLocaleString()}</span>
    </span>
  );
}
