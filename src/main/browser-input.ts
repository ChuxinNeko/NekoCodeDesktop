import type { BrowserPointerUpdate } from "../shared/browser";

export interface BrowserInputPage {
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	isDestroyed(): boolean;
	debugger: {
		isAttached(): boolean;
		attach(version?: string): void;
		detach(): void;
		sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
	};
}

export interface BrowserInputAction {
	action: "click" | "hover" | "scroll" | "type" | "drag" | "keypress";
	selector?: string;
	x?: number;
	y?: number;
	toX?: number;
	toY?: number;
	scrollY?: number;
	deltaX?: number;
	deltaY?: number;
	text?: string;
	key?: string;
	button?: "left" | "middle" | "right";
	clickCount?: number;
}

const positions = new WeakMap<BrowserInputPage, { x: number; y: number }>();
const busy = new WeakSet<BrowserInputPage>();

/** Native Chromium input, with the visible pointer following the very same coordinates. */
export async function performBrowserInput(page: BrowserInputPage, action: BrowserInputAction, options: {
	signal: AbortSignal;
	onPointer: (update: BrowserPointerUpdate) => void;
	onDispatched?: () => void;
	platform?: string;
}): Promise<void> {
	if (busy.has(page)) throw new Error("This browser tab is already performing an interaction");
	busy.add(page);
	const { signal, onPointer } = options;
	let point = positions.get(page) ?? { x: 24, y: 24 };
	let held: "left" | "middle" | "right" | undefined;
	let keyHeld: Record<string, unknown> | undefined;
	let attachedHere = false;
	let pointerShown = positions.has(page);
	const check = () => {
		if (signal.aborted) throw new Error("Browser interaction cancelled");
		if (page.isDestroyed()) throw new Error("Browser tab was closed");
	};
	const pause = (ms: number) => new Promise<void>((resolve, reject) => {
		check();
		const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, ms);
		const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Browser interaction cancelled")); };
		signal.addEventListener("abort", abort, { once: true });
	});
	const emit = (phase: BrowserPointerUpdate["phase"]) => {
		pointerShown = true;
		onPointer({ ...point, phase });
	};
	const cancellable = async <T>(operation: () => Promise<T>): Promise<T> => {
		check();
		const result = await new Promise<T>((resolve, reject) => {
			const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Browser interaction cancelled")); };
			signal.addEventListener("abort", abort, { once: true });
			operation().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
		check();
		return result;
	};
	const command = (method: string, params: Record<string, unknown>) => cancellable(() => page.debugger.sendCommand(method, params));
	const mouse = (type: string, extra: Record<string, unknown> = {}) => command("Input.dispatchMouseEvent", {
		type, ...point, button: held ?? "none", buttons: held === "left" ? 1 : held === "right" ? 2 : held === "middle" ? 4 : 0, ...extra,
	});
	const move = async (target: { x: number; y: number }, steps = 12) => {
		const from = { ...point };
		for (let step = 1; step <= steps; step++) {
			const t = step / steps;
			const eased = t * t * (3 - 2 * t);
			point = { x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased };
			await mouse("mouseMoved");
			positions.set(page, point);
			emit(held ? "down" : "move");
			await pause(16);
		}
	};
	const click = async (button: "left" | "middle" | "right", count = 1) => {
		for (let index = 1; index <= count; index++) {
			held = button;
			if (action.action === "click") options.onDispatched?.();
			await mouse("mousePressed", { clickCount: index });
			emit("down");
			await pause(60);
			await mouse("mouseReleased", { button, buttons: 0, clickCount: index });
			held = undefined;
			emit("up");
		}
	};
	const press = async (key: string, modifiers = 0) => {
		const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32, a: 65 };
		if (!(key in codes)) throw new Error(`Unsupported key: ${key}`);
		const data = { key, windowsVirtualKeyCode: codes[key], modifiers, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) };
		keyHeld = data;
		if (action.action === "keypress") options.onDispatched?.();
		await command("Input.dispatchKeyEvent", { type: "keyDown", ...data });
		await command("Input.dispatchKeyEvent", { type: "keyUp", ...data, text: undefined });
		keyHeld = undefined;
	};
	try {
		check();
		// DOM is used only to locate and validate a target; events never come from DOM scripts.
		const target = await cancellable(() => page.executeJavaScript(`(() => { try {
			const selector = ${JSON.stringify(action.selector ?? null)};
			let el = selector ? document.querySelector(selector) : null;
			if (selector && !el) throw new Error('No element matches selector: ' + selector);
			if (el) {
				const before = el.getBoundingClientRect();
				// Recentring a visible submenu can move its trigger out from under the pointer.
				let needsScroll = before.left < 0 || before.top < 0 || before.right > innerWidth || before.bottom > innerHeight;
				for (let parent = el.parentElement; parent && !needsScroll; parent = parent.parentElement) {
					const style = getComputedStyle(parent);
					const clip = parent.getBoundingClientRect();
					needsScroll = (/auto|scroll|hidden|clip/.test(style.overflowY) && (before.top < clip.top + parent.clientTop || before.bottom > clip.top + parent.clientTop + parent.clientHeight)) ||
						(/auto|scroll|hidden|clip/.test(style.overflowX) && (before.left < clip.left + parent.clientLeft || before.right > clip.left + parent.clientLeft + parent.clientWidth));
				}
				if (before.width && before.height && needsScroll) {
					el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
				}
			}
			const r = el?.getBoundingClientRect();
			const x = ${JSON.stringify(action.x ?? null)} ?? (r ? (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2 : innerWidth / 2);
			const y = ${JSON.stringify(action.y ?? null)} ?? (r ? (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2 : innerHeight / 2);
			if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error('Target is outside the viewport');
			if (!el && ${JSON.stringify(action.action)} === 'type') el = document.elementFromPoint(x, y);
			if (${JSON.stringify(action.action)} === 'type' && !el) throw new Error('Target is not editable');
			if (el) {
				const hit = document.elementFromPoint(x, y);
				const bounds = el.getBoundingClientRect();
				if (!bounds.width || !bounds.height || !hit || (hit !== el && !el.contains(hit)) || el.matches(':disabled,[aria-disabled="true"]') || el.closest('[inert]')) throw new Error('Target is hidden, disabled or covered');
				if (${JSON.stringify(action.action)} === 'type' && !el.isContentEditable && !el.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=file]):not([type=color]),textarea')) throw new Error('Target is not editable');
				if (${JSON.stringify(action.action)} === 'type' && el.readOnly) throw new Error('Target is read-only');
			}
			const from = ${JSON.stringify(point)};
			const destination = { x, y };
			let path = [destination];
			let jump = false;
			const targetElement = el || document.elementFromPoint(x, y);
			// Keep a hover menu's ancestor active while crossing into its submenu.
			let shared = targetElement;
			while (shared && !shared.matches(':hover')) shared = shared.parentElement;
			if (shared && shared !== document.body && shared !== document.documentElement) {
				const safe = (points) => {
					let start = from;
					for (const end of points) {
						for (let step = 1; step <= 12; step++) {
							const progress = step / 12;
							const t = progress * progress * (3 - 2 * progress);
							const hit = document.elementFromPoint(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t);
							if (!hit || !shared.contains(hit)) return false;
						}
						start = end;
					}
					return true;
				};
				if (!safe(path)) {
					const candidates = [[{ x: from.x, y }, destination], [{ x, y: from.y }, destination]];
					const route = candidates.find(safe);
					if (route) path = route;
					// Native mice also cross small menu gaps between input samples. One native
					// move avoids dwelling in a gap; no CSS state or synthetic events are forced.
					else jump = true;
				}
			}
			return { x, y, scrollY, width: innerWidth, height: innerHeight, path, jump };
		} catch (error) { return { error: String(error.message || error) }; } })()`, true)) as {
			x: number; y: number; scrollY: number; width: number; height: number; error?: string;
			path?: { x: number; y: number }[]; jump?: boolean;
		};
		check();
		if (target?.error) throw new Error(target.error);
		if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error("Could not locate an interaction target");
		if (!page.debugger.isAttached()) { page.debugger.attach("1.3"); attachedHere = true; }
		const approach = async () => {
			for (const waypoint of target.path ?? [target]) await move(waypoint, target.jump ? 1 : 12);
			if (action.selector && action.action !== "scroll") {
				const verified = await cancellable(() => page.executeJavaScript(`(() => {
					const verifyTarget = document.querySelector(${JSON.stringify(action.selector)});
					const hit = document.elementFromPoint(${point.x}, ${point.y});
					return !!verifyTarget && !!hit && (verifyTarget === hit || verifyTarget.contains(hit)) &&
						!verifyTarget.matches(':disabled,[aria-disabled="true"]') && !verifyTarget.closest('[inert]');
				})()`, true));
				if (verified !== true) throw new Error("Target moved, became hidden or was covered during pointer movement");
			}
		};
		if (action.action !== "keypress") await approach();
		switch (action.action) {
			case "hover": break;
			case "click": await click(action.button ?? "left", action.clickCount ?? 1); break;
			case "drag": {
				if (!Number.isFinite(action.toX) || !Number.isFinite(action.toY) || action.toX! < 0 || action.toY! < 0 || action.toX! >= target.width || action.toY! >= target.height) throw new Error("drag requires toX/toY inside the viewport");
				held = "left";
				await mouse("mousePressed", { clickCount: 1 }); emit("down");
				await move({ x: action.toX!, y: action.toY! });
				options.onDispatched?.();
				await mouse("mouseReleased", { button: "left", buttons: 0, clickCount: 1 }); held = undefined; emit("up");
				break;
			}
			case "scroll": {
				const deltaY = action.scrollY === undefined ? action.deltaY ?? 0 : action.scrollY - target.scrollY;
				await mouse("mouseWheel", { deltaX: action.deltaX ?? 0, deltaY }); emit("scroll");
				await pause(120);
				break;
			}
			case "type": {
				if (typeof action.text !== "string") throw new Error("type requires text");
				await click("left");
				await press("a", (options.platform ?? process.platform) === "darwin" ? 4 : 2);
				await press("Backspace");
				const chars = Array.from(action.text);
				for (let offset = 0; offset < chars.length; offset += 16) {
					emit("type");
					await command("Input.insertText", { text: chars.slice(offset, offset + 16).join("") });
					await pause(20);
				}
				break;
			}
			case "keypress":
				if (!action.key) throw new Error("keypress requires key");
				if (action.selector) { await approach(); await click("left"); }
				emit("key"); await press(action.key); break;
		}
	} finally {
		// Release held input even after abort/navigation, without starting another action.
		if (!page.isDestroyed()) {
			try {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						(async () => {
							if (held) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: held, buttons: 0, clickCount: 1 });
							if (keyHeld) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...keyHeld, text: undefined });
						})(),
						new Promise(resolve => { timer = setTimeout(resolve, 250); }),
					]);
				} finally { clearTimeout(timer); }
			} catch { /* The previous document may already be gone. */ }
			if (attachedHere) { try { page.debugger.detach(); } catch {} }
		}
		// Keep the cursor at the last input position, including after a navigating
		// click or cancellation; only the activity indicator returns to idle.
		if (pointerShown) emit("idle");
		busy.delete(page);
	}
}
