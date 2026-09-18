// FILE: diff-view.tsx
// Purpose: Single source of truth for rendering a unified diff — the review panel's
//          git patches and the checkpoint panel's computed ones read identically.
// Layer: UI primitive

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * A unified diff, coloured.
 *
 * Deliberately a line-prefix reader rather than a patch parser: the input is
 * already a unified diff, and the only question each line asks is which of four
 * things it is. `+++` and `---` are checked before `+` and `-` so a file header
 * is not painted as a whole added line.
 */
export function DiffView({
	patch,
	/** Shown instead of the diff when there is nothing to draw. */
	empty,
	className,
}: {
	patch: string;
	empty: ReactNode;
	className?: string;
}) {
	if (!patch.trim()) {
		return (
			<p className="px-3 py-4 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{empty}
			</p>
		);
	}
	const lines = patch.split("\n");
	return (
		<pre
			className={cn(
				"overflow-auto p-3 font-mono text-[length:var(--app-font-size-chat-code,11px)] leading-5",
				className,
			)}
		>
			{lines.map((line, index) => {
				const key = `${String(index)}:${line.slice(0, 24)}`;
				const isAdd = line.startsWith("+") && !line.startsWith("+++");
				const isRemove = line.startsWith("-") && !line.startsWith("---");
				const isMeta =
					line.startsWith("@@") ||
					line.startsWith("diff ") ||
					line.startsWith("index ") ||
					line.startsWith("+++") ||
					line.startsWith("---");
				return (
					<div
						key={key}
						className={cn(
							"whitespace-pre",
							isAdd && "bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-success",
							isRemove &&
								"bg-[color-mix(in_srgb,var(--destructive)_16%,transparent)] text-destructive",
							isMeta && "text-muted-foreground",
						)}
					>
						{line || " "}
					</div>
				);
			})}
		</pre>
	);
}
