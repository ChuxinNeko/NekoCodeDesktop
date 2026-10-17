/** Who drives the remote desktop. The other side's input is refused, not merged. */
export type DesktopController = "agent" | "user";

export type DesktopPhase = "connecting" | "connected" | "closed";

export interface DesktopResolutionInfo {
	width: number;
	height: number;
	modes: Array<{ width: number; height: number }>;
	/** XRDP owns the monitor layout; resize it from the RDP client. */
	blockedReason: "rdp" | "multiple-monitors" | null;
}

export function validateDesktopResolution(width: number, height: number): void {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256 || width > 4096 || height > 4096)
		throw new Error("Resolution width and height must be whole numbers between 256 and 4096");
}

export interface DesktopState {
	hostId: string;
	hostName: string;
	phase: DesktopPhase;
	controller: DesktopController;
	width: number;
	height: number;
	/** The remote desktop's own name for itself, from the VNC handshake. */
	title: string;
	/** Why it closed or failed to open. */
	error: string | null;
}

/** A changed region of the framebuffer, RGBA, row-major. */
export interface DesktopFrame {
	hostId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Set when the whole screen is resent — after a resize, or on request. */
	full: boolean;
	/** The whole screen's size, so the panel can size its canvas from any frame. */
	screenWidth: number;
	screenHeight: number;
	data: Uint8Array;
}

/** Where the agent just acted, for the panel to mark. */
export interface DesktopAction {
	hostId: string;
	kind: "click" | "double_click" | "right_click" | "drag" | "move" | "type" | "key" | "scroll";
	x?: number;
	y?: number;
	label: string;
}

export interface DesktopPointerInput {
	hostId: string;
	x: number;
	y: number;
	/** RFB button mask: 1 left, 2 middle, 4 right, 8 wheel up, 16 wheel down. */
	buttons: number;
}

export interface DesktopKeyInput {
	hostId: string;
	keysym: number;
	down: boolean;
}

/**
 * X11 keysyms by name, for both the agent's key combos ("ctrl+shift+t") and
 * the panel's KeyboardEvent.key values. Lower-case lookup.
 */
const NAMED_KEYSYMS: Record<string, number> = {
	backspace: 0xff08,
	tab: 0xff09,
	enter: 0xff0d,
	return: 0xff0d,
	escape: 0xff1b,
	esc: 0xff1b,
	delete: 0xffff,
	del: 0xffff,
	insert: 0xff63,
	home: 0xff50,
	end: 0xff57,
	pageup: 0xff55,
	page_up: 0xff55,
	pagedown: 0xff56,
	page_down: 0xff56,
	left: 0xff51,
	arrowleft: 0xff51,
	up: 0xff52,
	arrowup: 0xff52,
	right: 0xff53,
	arrowright: 0xff53,
	down: 0xff54,
	arrowdown: 0xff54,
	shift: 0xffe1,
	control: 0xffe3,
	ctrl: 0xffe3,
	alt: 0xffe9,
	meta: 0xffeb,
	super: 0xffeb,
	win: 0xffeb,
	cmd: 0xffeb,
	os: 0xffeb,
	capslock: 0xffe5,
	printscreen: 0xff61,
	print: 0xff61,
	pause: 0xff13,
	menu: 0xff67,
	contextmenu: 0xff67,
	space: 0x0020,
	" ": 0x0020,
	f1: 0xffbe,
	f2: 0xffbf,
	f3: 0xffc0,
	f4: 0xffc1,
	f5: 0xffc2,
	f6: 0xffc3,
	f7: 0xffc4,
	f8: 0xffc5,
	f9: 0xffc6,
	f10: 0xffc7,
	f11: 0xffc8,
	f12: 0xffc9,
};

/** The keysym that types one character: Latin-1 as itself, the rest in the Unicode range. */
export function keysymForChar(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (char === "\n" || char === "\r") return 0xff0d;
	if (char === "\t") return 0xff09;
	if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
	return 0x01000000 + code;
}

/** A named key or a single character; null when it is neither. */
export function keysymForKey(name: string): number | null {
	const named = NAMED_KEYSYMS[name.toLowerCase()];
	if (named !== undefined) return named;
	return [...name].length === 1 ? keysymForChar(name) : null;
}

/**
 * "ctrl+shift+t" as keysyms, modifiers first. Throws on a part it does not
 * know, so a typo reaches the model rather than a wrong key reaching the desktop.
 */
export function parseKeyCombo(combo: string): number[] {
	const parts = combo.trim() === "+" ? ["+"] : combo.split("+").map((part) => part.trim()).filter(Boolean);
	if (!parts.length) throw new Error("Empty key combination");
	return parts.map((part) => {
		const keysym = keysymForKey(part);
		if (keysym === null) throw new Error(`Unknown key: ${part}`);
		return keysym;
	});
}
