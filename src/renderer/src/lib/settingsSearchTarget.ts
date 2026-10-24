import type { TranslateFn, TranslationKey } from "../i18n";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** The rendered copy can contain counts or names in place of translation parameters. */
export function settingsTextMatches(template: string, text: string): boolean {
	const pattern = normalize(template).split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return !!pattern && new RegExp(`^${pattern}$`, "u").test(normalize(text));
}

/** Locate labels/hints first, then custom settings that do not use SettingsRow. */
export function findSettingsSearchTarget(root: HTMLElement, key: TranslationKey, t: TranslateFn): HTMLElement | null {
	const template = t(key);
	for (const row of root.querySelectorAll<HTMLElement>("[data-settings-row]")) {
		if (!row.getClientRects().length) continue;
		const anchor = row.dataset.settingsKey;
		if (anchor && (key === anchor || key.startsWith(`${anchor}.`))) return row;
		if ([row.dataset.settingsLabel, row.dataset.settingsHint].some((value) => value && settingsTextMatches(template, value))) return row;
	}
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const node = walker.currentNode;
		const element = node.parentElement;
		if (!element || !element.getClientRects().length || element.closest("button, input, textarea, select, [role='option']")) continue;
		if (settingsTextMatches(template, node.textContent ?? "")) {
			return element.closest<HTMLElement>("[data-settings-row]") ?? element;
		}
	}
	return null;
}

/** Scroll only the settings column; leave the sidebar and outer workspace in place. */
export function revealSettingsSearchTarget(root: HTMLElement, target: HTMLElement): void {
	const rootRect = root.getBoundingClientRect();
	const targetRect = target.getBoundingClientRect();
	root.scrollTo({ top: Math.max(0, root.scrollTop + targetRect.top - rootRect.top - 24), behavior: "instant" });
	target.animate?.([
		{ backgroundColor: "var(--sidebar-selected)", outline: "2px solid var(--color-border-focus)" },
		{ backgroundColor: "transparent", outline: "2px solid transparent" },
	], { duration: 1800, easing: "ease-out" });
}
