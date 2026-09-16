import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: CxOptions) {
	return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
	return /mac|darwin|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
	return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
	return /linux/i.test(platform);
}

/** The host platform string, safe to read where `navigator` may be absent (SSR, node tests). */
export function getNavigatorPlatform(): string {
	return typeof navigator === "undefined" ? "" : navigator.platform;
}

/** Single source of truth for "render the ⌘ affordance instead of the Ctrl one". */
export function isMacNavigatorPlatform(): boolean {
	return isMacPlatform(getNavigatorPlatform());
}

export function randomUUID(): string {
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Fallback for non-secure contexts where `crypto.randomUUID` is unavailable.
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
