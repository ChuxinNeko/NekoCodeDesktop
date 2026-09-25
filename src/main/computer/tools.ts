import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { RAISE_WINDOW, type ComputerCallResult } from "./protocol";

/**
 * Computer Use tools: the model's view of the desktop driver.
 *
 * Deliberately a small set with short schemas. The driver itself exposes
 * about sixty tools whose schemas come to roughly 150 KB; sending that on every
 * step would cost more context than most tasks spend on the work. These
 * eleven cover observing, launching and operating native windows, and each maps
 * onto one driver tool.
 *
 * The element cache is kept here, not left to the model. The driver requires
 * the snapshot id that produced an element index; remembering the latest one
 * per window lets the model say "element 12 in window W" and nothing more.
 */

export const COMPUTER_TOOL_NAMES = [
	"computer_list_apps",
	"computer_list_windows",
	"computer_launch_app",
	"computer_get_window_state",
	"computer_click",
	"computer_type_text",
	"computer_press_key",
	"computer_scroll",
	"computer_set_value",
	"computer_drag",
	"computer_screenshot",
] as const;

export interface ComputerCaller {
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerCallResult>;
}

/** A point on the screen in physical pixels, the driver's coordinate space. */
export interface ScreenPoint {
	x: number;
	y: number;
}

/** What the on-screen agent cursor should show for the action about to run. */
export interface PointerAction {
	kind: "click" | "type" | "key" | "scroll" | "drag" | "set_value";
	label: string;
	/** Where the action lands, when it is known. */
	at?: ScreenPoint;
	/** A drag's end. */
	to?: ScreenPoint;
	/** Where to appear when `at` is unknown and the cursor is not up yet: the window's centre. */
	fallback?: ScreenPoint;
}

/**
 * Something that shows the user where the agent is acting. `act` runs before
 * the driver call and may take a moment — the glide is what makes an action
 * visible — but it never decides whether the action happens.
 */
export interface ComputerPointer {
	act(action: PointerAction): Promise<void>;
	/** The action is over. */
	settle(): void;
}

/** Past this a tree is noise the model scrolls past; `query` narrows it instead. */
const MAX_TEXT_CHARS = 40_000;

const pid = Type.Integer({ description: "Target process id, from computer_list_windows or computer_launch_app." });
const windowId = Type.Optional(
	Type.Integer({
		description: "Target window id (HWND). Defaults to the window last read with computer_get_window_state for this pid.",
	}),
);
const elementIndex = Type.Optional(
	Type.Integer({ description: "Element index from the latest computer_get_window_state of the window." }),
);
const pointX = Type.Optional(Type.Number({ description: "X in the window screenshot's pixels (use instead of element_index)." }));
const pointY = Type.Optional(Type.Number({ description: "Y in the window screenshot's pixels." }));
const foreground = Type.Optional(
	Type.Boolean({
		description:
			"Deliver by briefly bringing the window to the front. Only after the same action failed with background_unavailable; never preemptively.",
	}),
);

const listAppsSchema = Type.Object({
	include_installed: Type.Optional(
		Type.Boolean({ description: "Also list installed apps that are not running. Default false." }),
	),
});
const listWindowsSchema = Type.Object({
	pid: Type.Optional(Type.Integer({ description: "Only this process's windows." })),
});
const launchSchema = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				'App display name in the system language, e.g. "Notepad", or "计算器" on Chinese Windows. If it is not found, get the launch_path from computer_list_apps with include_installed.',
		}),
	),
	aumid: Type.Optional(Type.String({ description: "AppUserModelID of a packaged (Store) app." })),
	path: Type.Optional(Type.String({ description: "Full path to an executable." })),
	launch_path: Type.Optional(Type.String({ description: "launch_path returned by computer_list_apps." })),
	urls: Type.Optional(Type.Array(Type.String(), { description: "URLs to open in the default browser." })),
	arguments: Type.Optional(Type.Array(Type.String(), { description: "Extra command-line arguments." })),
});
const windowStateSchema = Type.Object({
	pid,
	window_id: Type.Integer({ description: "Window id (HWND) from computer_list_windows or computer_launch_app." }),
	query: Type.Optional(
		Type.String({ description: "Case-insensitive filter: keep matching elements and their ancestors." }),
	),
	include_screenshot: Type.Optional(
		Type.Boolean({ description: "Attach a screenshot of the window. Default true; false is cheaper for re-indexing." }),
	),
	max_depth: Type.Optional(Type.Integer({ minimum: 1, description: "Tree depth limit. Default 25." })),
});
const clickSchema = Type.Object({
	pid,
	window_id: windowId,
	element_index: elementIndex,
	x: pointX,
	y: pointY,
	button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "2 for a double click." })),
	foreground,
});
const typeSchema = Type.Object({
	pid,
	text: Type.String({ description: "Text to insert. Keys such as Enter or Tab go through computer_press_key." }),
	window_id: windowId,
	element_index: Type.Optional(
		Type.Integer({ description: "Field to write into. Required by modern (XAML/WinUI/UWP) apps such as Notepad." }),
	),
	x: pointX,
	y: pointY,
	foreground,
});
const keySchema = Type.Object({
	pid,
	keys: Type.Array(Type.String(), {
		minItems: 1,
		description:
			'One key, or modifiers followed by one key: ["return"], ["ctrl", "s"], ["ctrl", "shift", "t"]. Names: return, tab, escape, space, delete, backspace, up, down, left, right, home, end, pageup, pagedown, f1-f12, letters, digits; modifiers ctrl, shift, alt, win.',
	}),
	window_id: windowId,
	element_index: Type.Optional(Type.Integer({ description: "Element to focus before the key is sent." })),
	foreground,
});
const scrollSchema = Type.Object({
	pid,
	direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
	amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Ticks. Default 3." })),
	by: Type.Optional(Type.Union([Type.Literal("line"), Type.Literal("page")])),
	window_id: windowId,
	x: pointX,
	y: pointY,
	foreground,
});
const setValueSchema = Type.Object({
	pid,
	element_index: Type.Integer({ description: "Element index from the latest computer_get_window_state." }),
	value: Type.String({ description: "New value; for a combo box, the option's text." }),
	window_id: windowId,
});
const dragSchema = Type.Object({
	pid,
	from_x: Type.Number(),
	from_y: Type.Number(),
	to_x: Type.Number(),
	to_y: Type.Number(),
	window_id: windowId,
	foreground,
});
const screenshotSchema = Type.Object({});

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What one read of a window established: its snapshot and where things are. */
interface WindowSnapshot {
	id: string;
	/** The window on screen, in physical pixels. */
	bounds?: Rect;
	/** The screenshot's size; x/y arguments are in its pixels. */
	shot?: { width: number; height: number };
	elements: Map<number, { frame: Rect; name: string }>;
}

interface Target {
	pid: number;
	window_id?: number;
	element_index?: number;
	x?: number;
	y?: number;
	foreground?: boolean;
}

export function createComputerTools(host: ComputerCaller, pointer?: ComputerPointer): ToolDefinition[] {
	/** Latest read of each window, keyed `pid:window`. */
	const snapshots = new Map<string, WindowSnapshot>();
	/** The window each process was last read through. */
	const lastWindow = new Map<number, number>();

	/** Driver arguments that address a target, with the snapshot filled in. */
	const targetArgs = (target: Target): Record<string, unknown> => {
		const args: Record<string, unknown> = { pid: target.pid };
		const window = target.window_id ?? lastWindow.get(target.pid);
		if (window !== undefined) args.window_id = window;
		if (target.element_index !== undefined) {
			if (target.x !== undefined || target.y !== undefined) {
				throw new Error("Pass either element_index or x/y, not both.");
			}
			const snapshot = window === undefined ? undefined : snapshots.get(`${target.pid}:${window}`);
			if (window === undefined || !snapshot) {
				throw new Error(
					"element_index needs a computer_get_window_state of that window first; call it, then use an index from its result.",
				);
			}
			args.element_index = target.element_index;
			args.snapshot_id = snapshot.id;
		} else if ((target.x === undefined) !== (target.y === undefined)) {
			throw new Error("x and y must be given together.");
		} else if (target.x !== undefined) {
			args.x = target.x;
			args.y = target.y;
		}
		if (target.foreground) args.delivery_mode = "foreground";
		return args;
	};

	/** Where a target is on screen, as far as the last read of its window tells. */
	const locate = (target: Target): { at?: ScreenPoint; fallback?: ScreenPoint; name?: string } => {
		const window = target.window_id ?? lastWindow.get(target.pid);
		const snapshot = window === undefined ? undefined : snapshots.get(`${target.pid}:${window}`);
		const fallback = snapshot?.bounds ? centre(snapshot.bounds) : undefined;
		if (target.element_index !== undefined) {
			const element = snapshot?.elements.get(target.element_index);
			return { at: element ? centre(element.frame) : undefined, fallback, name: element?.name };
		}
		if (target.x !== undefined && target.y !== undefined && snapshot) {
			return { at: fromScreenshot(snapshot, target.x, target.y), fallback };
		}
		return { fallback };
	};

	/** Show the action on screen, then perform it. */
	const act = async (
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		action: PointerAction,
	) => {
		// Both are for the user watching, and neither decides whether the action
		// runs: a window that will not come up or a cursor that cannot be drawn
		// leaves the action to go ahead unseen.
		if (pointer) {
			// The cursor alone over NekoCode shows nothing; the window it is working
			// in has to be in view. Raised above the others, but not activated, so
			// the keyboard stays wherever the user left it.
			if (typeof args.window_id === "number") {
				await host.call(RAISE_WINDOW, { window_id: args.window_id }, signal).catch(() => undefined);
			}
			await pointer.act(action).catch(() => undefined);
		}
		try {
			return await run(name, args, signal);
		} finally {
			pointer?.settle();
		}
	};

	const run = async (name: string, args: Record<string, unknown>, signal: AbortSignal | undefined) => {
		const result = await host.call(name, args, signal);
		if (result.isError) {
			const code = result.errorCode ? `[${result.errorCode}] ` : "";
			throw new Error(`${code}${result.text || `${name} failed`}`);
		}
		return result;
	};

	const reply = (result: ComputerCallResult, details: Record<string, unknown>) => {
		let text = result.text.trim() || "Done.";
		if (text.length > MAX_TEXT_CHARS) {
			text = `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated; narrow it with query or max_depth)`;
		}
		return {
			content: [
				{ type: "text" as const, text },
				...result.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
			],
			details,
		};
	};

	const tool = <T extends TSchema>(
		name: (typeof COMPUTER_TOOL_NAMES)[number],
		description: string,
		parameters: T,
		execute: (params: Static<T>, signal: AbortSignal | undefined) => Promise<ReturnType<typeof reply>>,
	): ToolDefinition =>
		({
			name,
			label: name,
			description,
			parameters,
			// One desktop, one pointer: two actions racing each other on it would
			// each observe the other's half-finished state.
			executionMode: "sequential",
			execute: (_id: string, params: Static<T>, signal: AbortSignal | undefined) => execute(params, signal),
		}) as unknown as ToolDefinition;

	return [
		tool(
			"computer_list_apps",
			"List apps on this Windows desktop: running ones with their pid, and optionally installed ones with the launch_path computer_launch_app accepts.",
			listAppsSchema,
			async (params, signal) => {
				const result = await run("list_apps", {}, signal);
				if (params.include_installed) return reply(result, {});
				return reply({ ...result, text: runningAppsText(result) }, {});
			},
		),
		tool(
			"computer_list_windows",
			"List the visible top-level windows with pid, window_id, title and bounds. Start here to find the window to work in.",
			listWindowsSchema,
			async (params, signal) =>
				reply(
					await run("list_windows", { on_screen_only: true, ...(params.pid !== undefined ? { pid: params.pid } : {}) }, signal),
					{},
				),
		),
		tool(
			"computer_launch_app",
			"Launch an app without taking focus. Give one of name, aumid, path or launch_path. Returns a pid and the app's windows; use those window ids — for Store apps the pid is the shared frame host, not the app itself.",
			launchSchema,
			async (params, signal) => {
				const { arguments: extra, ...rest } = params;
				if (!rest.name && !rest.aumid && !rest.path && !rest.launch_path && !rest.urls?.length) {
					throw new Error("Give one of name, aumid, path, launch_path or urls.");
				}
				return reply(
					await run("launch_app", { ...rest, ...(extra?.length ? { additional_arguments: extra } : {}) }, signal),
					{},
				);
			},
		),
		tool(
			"computer_get_window_state",
			[
				"Read a window: its UI Automation tree, where every actionable element is tagged [N], and a screenshot.",
				"Call it before acting on a window and again after each change you need to see; element indices are only valid for the latest read of that window.",
				"Prefer element_index over x/y: it works on background windows and does not move the user's mouse.",
				"x/y are pixels in this screenshot. Actions run in the background by default and leave the user's focus alone.",
				"Check the result after acting instead of assuming the action worked.",
			].join(" "),
			windowStateSchema,
			async (params, signal) => {
				const result = await run(
					"get_window_state",
					{
						pid: params.pid,
						window_id: params.window_id,
						...(params.query ? { query: params.query } : {}),
						...(params.include_screenshot === false ? { include_screenshot: false } : {}),
						...(params.max_depth ? { max_depth: params.max_depth } : {}),
					},
					signal,
				);
				const snapshot = readSnapshot(result.structuredJson);
				if (snapshot) snapshots.set(`${params.pid}:${params.window_id}`, snapshot);
				lastWindow.set(params.pid, params.window_id);
				return reply(result, { pid: params.pid, windowId: params.window_id });
			},
		),
		tool(
			"computer_click",
			"Click an element (element_index) or a point (x, y) in a window. button and count cover right and double clicks.",
			clickSchema,
			async (params, signal) => {
				const args = targetArgs(params);
				if (args.element_index === undefined && args.x === undefined) {
					throw new Error("Give element_index or x and y.");
				}
				if (params.button) args.button = params.button;
				if (params.count) args.count = params.count;
				const place = locate(params);
				const verb = params.button === "right" ? "右键" : (params.count ?? 1) > 1 ? "双击" : "点击";
				return reply(
					await act("click", args, signal, { kind: "click", label: labelled(verb, place.name), ...place }),
					{},
				);
			},
		),
		tool(
			"computer_type_text",
			"Type text into a window's focused field, or into element_index / the field at x, y.",
			typeSchema,
			async (params, signal) =>
				reply(
					await act("type_text", { ...targetArgs(params), text: params.text }, signal, {
						kind: "type",
						label: labelled("输入", preview(params.text)),
						...locate(params),
					}),
					{},
				),
		),
		tool(
			"computer_press_key",
			"Press a key or a key combination in a window, e.g. [\"return\"] or [\"ctrl\", \"s\"].",
			keySchema,
			async (params, signal) => {
				const keys = params.keys.map((key) => key.trim().toLowerCase()).filter(Boolean);
				if (!keys.length) throw new Error("keys is empty.");
				const args = targetArgs(params);
				const action: PointerAction = {
					kind: "key",
					label: labelled("按键", keys.map(keyName).join("+")),
					...locate(params),
				};
				if (keys.length === 1) return reply(await act("press_key", { ...args, key: keys[0] }, signal, action), {});
				return reply(await act("hotkey", { ...args, keys }, signal, action), {});
			},
		),
		tool(
			"computer_scroll",
			"Scroll a window. x, y pick a nested scroll area in foreground delivery.",
			scrollSchema,
			async (params, signal) => {
				const args = targetArgs(params);
				args.direction = params.direction;
				if (params.amount) args.amount = params.amount;
				if (params.by) args.by = params.by;
				const arrow = { up: "↑", down: "↓", left: "←", right: "→" }[params.direction];
				return reply(
					await act("scroll", args, signal, { kind: "scroll", label: `滚动 ${arrow}`, ...locate(params) }),
					{},
				);
			},
		),
		tool(
			"computer_set_value",
			"Set an element's value directly (text field, slider, combo box) through UI Automation, without typing.",
			setValueSchema,
			async (params, signal) =>
				reply(
					await act("set_value", { ...targetArgs(params), value: params.value }, signal, {
						kind: "set_value",
						label: labelled("设置", preview(params.value)),
						...locate(params),
					}),
					{},
				),
		),
		tool(
			"computer_drag",
			"Press, drag and release between two points in the window screenshot's pixels.",
			dragSchema,
			async (params, signal) => {
				const args = targetArgs(params);
				Object.assign(args, { from_x: params.from_x, from_y: params.from_y, to_x: params.to_x, to_y: params.to_y });
				const from = locate({ ...params, x: params.from_x, y: params.from_y });
				const to = locate({ ...params, x: params.to_x, y: params.to_y });
				return reply(await act("drag", args, signal, { kind: "drag", label: "拖拽", ...from, to: to.at }), {});
			},
		),
		tool(
			"computer_screenshot",
			"Screenshot the whole primary display. For working inside one window, computer_get_window_state is better: it also returns clickable elements.",
			screenshotSchema,
			async (_params, signal) => reply(await run("get_desktop_state", {}, signal), {}),
		),
	];
}

function readSnapshot(structuredJson: string | undefined): WindowSnapshot | undefined {
	if (!structuredJson) return undefined;
	let parsed: {
		snapshot_id?: unknown;
		window_bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
		screenshot_width?: unknown;
		screenshot_height?: unknown;
		elements?: unknown;
	};
	try {
		parsed = JSON.parse(structuredJson);
	} catch {
		return undefined;
	}
	if (typeof parsed.snapshot_id !== "string") return undefined;
	const elements = new Map<number, { frame: Rect; name: string }>();
	if (Array.isArray(parsed.elements)) {
		for (const entry of parsed.elements as Record<string, unknown>[]) {
			const frame = entry.frame as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
			if (typeof entry.element_index !== "number" || !frame) continue;
			const rect = toRect(frame.x, frame.y, frame.w, frame.h);
			if (!rect) continue;
			const name = [entry.role, entry.label].filter((part) => typeof part === "string" && part).join(" ");
			elements.set(entry.element_index, { frame: rect, name });
		}
	}
	const bounds = parsed.window_bounds;
	const width = parsed.screenshot_width;
	const height = parsed.screenshot_height;
	return {
		id: parsed.snapshot_id,
		bounds: bounds ? toRect(bounds.x, bounds.y, bounds.width, bounds.height) : undefined,
		shot: typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? { width, height } : undefined,
		elements,
	};
}

function toRect(x: unknown, y: unknown, width: unknown, height: unknown): Rect | undefined {
	if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
		return undefined;
	}
	return { x, y, width, height };
}

function centre(rect: Rect): ScreenPoint {
	return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

/**
 * Screenshot pixels to screen pixels. Element frames and window bounds come
 * back in physical screen pixels; the screenshot may be scaled down from the
 * window, so x/y are scaled back up by the same ratio.
 */
function fromScreenshot(snapshot: WindowSnapshot, x: number, y: number): ScreenPoint | undefined {
	const bounds = snapshot.bounds;
	if (!bounds) return undefined;
	const scaleX = snapshot.shot ? bounds.width / snapshot.shot.width : 1;
	const scaleY = snapshot.shot ? bounds.height / snapshot.shot.height : 1;
	return { x: Math.round(bounds.x + x * scaleX), y: Math.round(bounds.y + y * scaleY) };
}

function labelled(verb: string, detail: string | undefined): string {
	return detail ? `${verb} · ${detail}` : verb;
}

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

function keyName(key: string): string {
	return key.charAt(0).toUpperCase() + key.slice(1);
}

interface ListedApp {
	name?: unknown;
	pid?: unknown;
	running?: unknown;
	active?: unknown;
}

/**
 * The running apps only. The full list includes every Start-menu shortcut on
 * the machine, often hundreds of lines the model rarely needs.
 */
function runningAppsText(result: ComputerCallResult): string {
	try {
		const parsed = JSON.parse(result.structuredJson ?? "") as { apps?: ListedApp[] };
		if (!Array.isArray(parsed.apps)) return result.text;
		const running = parsed.apps.filter((app) => app.running === true);
		return [
			`${running.length} running app(s):`,
			...running.map((app) => `- ${String(app.name)} (pid ${String(app.pid)})${app.active === true ? " [active]" : ""}`),
		].join("\n");
	} catch {
		return result.text;
	}
}
