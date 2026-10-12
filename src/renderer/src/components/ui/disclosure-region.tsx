import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { DISCLOSURE_DURATION_MS, useReducedMotion } from "../../lib/motion";
import { cn } from "../../lib/utils";

/** Animate explicit toggles; streamed content keeps its natural height. */
export function DisclosureRegion({ open, children, className, id }: {
	open: boolean;
	children: ReactNode;
	className?: string;
	id?: string;
}) {
	const reduced = useReducedMotion();
	const [present, setPresent] = useState(open);
	useEffect(() => {
		if (open) { setPresent(true); return; }
		if (reduced) { setPresent(false); return; }
		const timer = window.setTimeout(() => setPresent(false), DISCLOSURE_DURATION_MS + 20);
		return () => window.clearTimeout(timer);
	}, [open, reduced]);
	return <div id={id} className="workflow-disclosure" data-open={open} inert={!open} aria-hidden={!open}
		style={{ "--workflow-motion-duration": `${DISCLOSURE_DURATION_MS}ms` } as CSSProperties}>
		<div className="workflow-disclosure-inner">
			{open || present ? <div className={cn(className)}>{children}</div> : null}
		</div>
	</div>;
}
