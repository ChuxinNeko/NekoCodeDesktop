// FILE: format.ts
// Purpose: Small formatting helpers shared by the review workbench.
// Layer: Renderer lib

import type { GitFileChange } from "../../../../shared/git";
import type { GitLetter } from "../ide/git-decorations";
import type { Language } from "../../i18n";

/** A path split into the file name and the folders above it. */
export function splitPath(path: string): { dir: string; name: string } {
	const clean = path.replace(/\/$/, "");
	const slash = clean.lastIndexOf("/");
	return slash < 0 ? { dir: "", name: clean } : { dir: clean.slice(0, slash), name: clean.slice(slash + 1) };
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

/** "3 hours ago", in the UI language; empty for a date that cannot be read. */
export function relativeTime(iso: string | null | undefined, language: Language, now = Date.now()): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	const seconds = Math.round((time - now) / 1000);
	const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
	for (const [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
	}
	return formatter.format(0, "second");
}

export function absoluteTime(iso: string | null | undefined, language: Language): string {
	if (!iso) return "";
	const time = new Date(iso);
	if (Number.isNaN(time.getTime())) return "";
	return time.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	const first = Array.from(parts[0]!)[0] ?? "?";
	const second = parts.length > 1 ? (Array.from(parts[parts.length - 1]!)[0] ?? "") : "";
	return (first + second).toUpperCase();
}

/** The one-letter badge for a file inside a commit or range. */
export function changeLetter(change: Pick<GitFileChange, "status">): GitLetter {
	switch (change.status) {
		case "A":
		case "C":
			return "A";
		case "D":
			return "D";
		case "R":
			return "R";
		default:
			return "M";
	}
}

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		document.execCommand("copy");
		area.remove();
	}
}

/** Ref decorations worth a chip: branches and tags, without the `HEAD ->` pointer text. */
export function visibleRefs(refs: string[]): string[] {
	return refs
		.map((ref) => ref.replace(/^HEAD -> /, "").replace(/^tag: /, ""))
		.filter((ref) => ref && ref !== "HEAD" && !ref.endsWith("/HEAD"));
}
