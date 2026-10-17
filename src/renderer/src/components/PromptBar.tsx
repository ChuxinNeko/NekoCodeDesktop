import { useLayoutEffect, useRef, useState } from "react";

export interface PromptBarItem {
	key: string;
	name: string;
	description: string;
	argumentHint?: string;
}

interface PromptBarProps {
	items: readonly PromptBarItem[];
	activeIndex: number;
	label: string;
	emptyLabel: string;
	searchHint: string;
	keyboardHint: string;
	onHighlight: (index: number) => void;
	onPick: (index: number) => void;
}

/** Beautiful UI Prompt Bar's command popover, driven by the existing composer.
 * Focus stays in the textarea so typing, IME and command acceptance keep working.
 * The demo composer/model controls and their Glimm sweep are not part of this menu.
 */
export default function PromptBar(props: PromptBarProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
	const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);
	const activeKey = props.items[props.activeIndex]?.key;

	useLayoutEffect(() => {
		const row = rowRefs.current[props.activeIndex];
		if (!activeKey || !row) {
			setRowBox(null);
			return;
		}
		row.scrollIntoView({ block: "nearest" });
		const measure = () => setRowBox({ top: row.offsetTop, height: row.offsetHeight });
		measure();
		const observer = new ResizeObserver(measure);
		if (listRef.current) observer.observe(listRef.current);
		observer.observe(row);
		return () => observer.disconnect();
	}, [props.activeIndex, activeKey, props.items.length]);

	return (
		<div data-promptbar className="prompt-bar-menu overflow-hidden rounded-[10px] border border-border/60 bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_-8px_rgba(0,0,0,0.18),0_2px_6px_-2px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_30px_-8px_rgba(0,0,0,0.5)]">
			<div ref={listRef} role="listbox" aria-label={props.label} className="relative max-h-[min(18rem,45vh)] overflow-y-auto overscroll-contain">
				<span
					aria-hidden="true"
					className="prompt-bar-highlight pointer-events-none absolute inset-x-0 rounded-[6px] bg-[var(--color-background-button-secondary-hover)]"
					style={{ top: rowBox?.top ?? 0, height: rowBox?.height ?? 0, opacity: rowBox ? 1 : 0 }}
				/>
				{props.items.map((item, index) => (
					<div
						key={item.key}
						ref={(element) => { rowRefs.current[index] = element; }}
						role="option"
						aria-selected={index === props.activeIndex}
						className="relative z-10 flex h-9 w-full cursor-pointer select-none items-center gap-2.5 rounded-[6px] px-2 text-left"
						onPointerMove={() => props.onHighlight(index)}
						onPointerDown={(event) => {
							if (event.button !== 0) return;
							event.preventDefault();
							props.onPick(index);
						}}
					>
						<span className="max-w-[55%] shrink-0 truncate text-[12.5px] font-medium" title={item.name}>{item.name}</span>
						{item.argumentHint ? <span className="max-w-[20%] truncate font-mono text-[11px] text-muted-foreground/70" title={item.argumentHint}>{item.argumentHint}</span> : null}
						<span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" title={item.description}>{item.description}</span>
					</div>
				))}
				{props.items.length === 0 ? <div className="flex min-h-9 items-center px-2 text-[12px] text-muted-foreground">{props.emptyLabel}</div> : null}
			</div>
			<div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
				<span>{props.searchHint}</span>
				<span>{props.keyboardHint}</span>
			</div>
		</div>
	);
}
