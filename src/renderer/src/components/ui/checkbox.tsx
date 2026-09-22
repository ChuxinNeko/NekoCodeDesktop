"use client";

// FILE: checkbox.tsx
// Purpose: Shared accent-colored checkbox primitive for multi-select lists.
// Layer: Base UI component
// Exports: Checkbox

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "~/lib/icons";

import { cn } from "~/lib/utils";

/**
 * A box, not a switch: a switch says "this setting is on", a checkbox says
 * "this row is one of the ones I mean", which is what a list selection is.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return (
		<CheckboxPrimitive.Root
			className={cn(
				"flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border outline-none",
				"transition-[background-color,border-color,box-shadow] duration-150",
				"focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]/60",
				"data-checked:border-[color:var(--color-text-accent)] data-checked:bg-[var(--color-text-accent)]",
				"data-indeterminate:border-[color:var(--color-text-accent)] data-indeterminate:bg-[var(--color-text-accent)]",
				"data-unchecked:border-[color:color-mix(in_srgb,var(--color-text-foreground)_28%,transparent)]",
				"data-unchecked:bg-[var(--color-background-control-opaque)]",
				"data-disabled:cursor-not-allowed data-disabled:opacity-64",
				className,
			)}
			data-slot="checkbox"
			{...props}
		>
			<CheckboxPrimitive.Indicator
				className="flex text-white data-unchecked:hidden"
				data-slot="checkbox-indicator"
				render={(indicatorProps, state) => (
					<span {...indicatorProps}>
						{state.indeterminate ? (
							<MinusIcon className="size-3" />
						) : (
							<CheckIcon className="size-3" />
						)}
					</span>
				)}
			/>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
