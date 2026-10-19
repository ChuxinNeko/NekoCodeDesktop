import type { BrowserAutomationPointer } from "../../../shared/browser";
import { useTranslation } from "../i18n";

export function BrowserAutomationCursor({ pointer }: { pointer: BrowserAutomationPointer & { pulse: number } }) {
	const { t } = useTranslation();
	const phase = pointer.phase;
	return (
		<div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-hidden="true" data-browser-automation-overlay>
			{phase !== "idle" ? <div className="absolute right-3 top-3 rounded-full border border-blue-400/30 bg-slate-950/85 px-3 py-1.5 text-xs text-white shadow-lg">
				<span className="mr-2 inline-block size-1.5 rounded-full bg-blue-400" />
				{t(phase === "type" ? "browser.automationTyping" : phase === "scroll" ? "browser.automationScrolling" : "browser.automationOperating")}
			</div> : null}
			<div className="absolute left-0 top-0" style={{ transform: `translate(${pointer.x * pointer.scale}px, ${pointer.y * pointer.scale}px)` }}>
				{pointer.pulse > 0 ? <span key={pointer.pulse} className="browser-automation-click absolute -left-4 -top-4 size-8 rounded-full border-2 border-blue-400 bg-blue-400/25" /> : null}
				<svg width="25" height="29" viewBox="0 0 25 29" className="relative drop-shadow-md" style={{ transform: phase === "down" ? "scale(0.88)" : undefined, transformOrigin: "0 0" }}>
					<path d="M2 2L3 23L9 17L14 27L18 25L13 15L22 15Z" fill="#60a5fa" stroke="white" strokeWidth="2" strokeLinejoin="round" />
				</svg>
			</div>
		</div>
	);
}
