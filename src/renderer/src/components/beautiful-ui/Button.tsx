// Source: https://www.beautifului.dev/r/button.json (semantic utilities namespaced bui).
"use client";

import { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const filledShadow = "shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]";

/* Pill-shaped by default — the app's core button style. Explicit symmetric
 * padding (not a fixed height) so the top/bottom spacing is always equal. */
export const buttonVariants = cva(
  `inline-flex items-center justify-center font-medium select-none
   transition-[transform,background-color,opacity] duration-150 ease-out
   active:scale-[0.96] disabled:opacity-50 disabled:pointer-events-none`,
  {
    variants: {
      variant: {
        primary: `bg-bui-ink text-bui-canvas hover:opacity-90 dark:bg-bui-ink dark:text-bui-canvas ${filledShadow}`,
        secondary: "bg-bui-surface text-bui-ink shadow-bui-btn hover:bg-bui-inset aria-expanded:bg-bui-hover",
        ghost: "bg-bui-hover-2 text-bui-ink hover:bg-bui-line-strong",
        accent: `bg-bui-accent text-white hover:bg-bui-accent-ink ${filledShadow}`,
        success: `bg-bui-green text-white hover:brightness-95 ${filledShadow}`,
        /* transparent until hovered — for dense toolbars/action rows */
        quiet: "text-bui-ink hover:bg-bui-hover",
      },
      size: {
        /* compact toolbar pill — fixed height, lighter weight */
        xs: "h-7 rounded-full px-2.5 text-[12px] font-normal leading-none gap-1",
        /* canonical action pill — 27px tall, roomy sides */
        sm: "h-[27px] px-3 text-[13px] leading-none rounded-full gap-1.5",
        md: "px-4 py-[9px] text-sm leading-none rounded-full gap-2",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export function Button({
  variant,
  size,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
