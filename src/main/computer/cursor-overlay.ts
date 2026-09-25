import { BrowserWindow, screen } from "electron";
import type { ComputerPointer, PointerAction, ScreenPoint } from "./tools";

/**
 * The agent's cursor: a small always-on-top window that glides to where the
 * next action lands, so the user can follow what the agent is doing.
 *
 * It is its own little window rather than a full-screen transparent layer on
 * purpose. The driver hit-tests the target point before a pixel click, and a
 * foreground click is real input at that point; a layer covering the screen
 * would be under both. This window sits just below and right of the tip, so
 * the pixel being acted on is never ours.
 *
 * Content protection keeps it out of screenshots, including the ones sent to
 * the model — it should see the app, not our drawing over it.
 */

/** Window size in DIP: room for the arrow and a label beside it. */
const WIDTH = 280;
const HEIGHT = 64;
/** Gap between the target pixel and the window, in DIP. */
const TIP_GAP = 2;
const FRAME_MS = 16;
/** Hide after this long without an action. */
const IDLE_HIDE_MS = 2_500;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;user-select:none;
  font:600 12px/1.2 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif}
#root{position:relative;width:${WIDTH}px;height:${HEIGHT}px;opacity:0;transition:opacity .18s ease}
#root.on{opacity:1}
svg{position:absolute;left:0;top:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));
  transform-origin:0 0;transition:transform .12s ease}
#root.press svg{transform:scale(.82)}
#label{position:absolute;left:20px;top:22px;max-width:${WIDTH - 28}px;padding:3px 8px;border-radius:7px;
  background:rgba(124,58,237,.92);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  box-shadow:0 2px 6px rgba(0,0,0,.25)}
#label:empty{display:none}
</style></head><body><div id="root">
<svg width="22" height="26" viewBox="0 0 22 26"><path d="M1.5 1.5 L1.5 20.5 L6.6 15.9 L10.2 24 L13.6 22.5 L10.1 14.6 L17 14.4 Z"
  fill="#7c3aed" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
<div id="label"></div></div>
<script>
const root=document.getElementById("root"),label=document.getElementById("label");
window.cursor={
  show(text){label.textContent=text||"";root.classList.add("on")},
  press(){root.classList.remove("press");void root.offsetWidth;root.classList.add("press")},
  hide(){root.classList.remove("on")}
};
</script></body></html>`;

interface DipPoint {
	x: number;
	y: number;
}

export class CursorOverlay implements ComputerPointer {
	private window: BrowserWindow | null = null;
	private loaded: Promise<void> | null = null;
	/** Where the tip is, in DIP; null while hidden. */
	private position: DipPoint | null = null;
	private hideTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by each action so a superseded glide stops moving the window. */
	private generation = 0;

	async act(action: PointerAction): Promise<void> {
		clearTimeout(this.hideTimer);
		const generation = ++this.generation;
		const win = await this.ensure();
		if (!win || generation !== this.generation) return;
		const target = action.at ? this.toDip(action.at) : (this.position ?? this.toDip(action.fallback));
		if (!target) return;
		await this.run(win, `cursor.show(${JSON.stringify(action.label)})`);
		if (!win.isVisible()) {
			// Appearing: start a little up and left of the target, so the glide
			// itself says where the action is.
			this.place(win, this.position ?? { x: target.x - 60, y: target.y - 40 });
			win.showInactive();
		}
		await this.glide(win, target, generation);
		if (generation !== this.generation) return;
		if (action.kind === "drag" && action.to) {
			await this.run(win, "cursor.press()");
			const to = this.toDip(action.to);
			if (to) await this.glide(win, to, generation, 420);
		} else {
			await this.run(win, "cursor.press()");
		}
	}

	/** The action finished; hide once nothing follows for a while. */
	settle(): void {
		clearTimeout(this.hideTimer);
		const generation = this.generation;
		this.hideTimer = setTimeout(() => {
			if (generation !== this.generation || !this.window || this.window.isDestroyed()) return;
			void this.run(this.window, "cursor.hide()");
			const win = this.window;
			setTimeout(() => {
				if (generation === this.generation && !win.isDestroyed()) win.hide();
				if (generation === this.generation) this.position = null;
			}, 220);
		}, IDLE_HIDE_MS);
	}

	dispose(): void {
		clearTimeout(this.hideTimer);
		this.generation++;
		if (this.window && !this.window.isDestroyed()) this.window.destroy();
		this.window = null;
		this.loaded = null;
	}

	private async ensure(): Promise<BrowserWindow | null> {
		if (this.window && !this.window.isDestroyed()) {
			await this.loaded;
			return this.window;
		}
		const win = new BrowserWindow({
			width: WIDTH,
			height: HEIGHT,
			title: "NekoCode Agent Cursor",
			show: false,
			frame: false,
			transparent: true,
			backgroundColor: "#00000000",
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			focusable: false,
			skipTaskbar: true,
			hasShadow: false,
			alwaysOnTop: true,
			webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
		});
		win.setIgnoreMouseEvents(true);
		win.setAlwaysOnTop(true, "screen-saver");
		win.setContentProtection(true);
		win.on("closed", () => {
			if (this.window === win) {
				this.window = null;
				this.loaded = null;
				this.position = null;
			}
		});
		this.window = win;
		this.loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => undefined);
		await this.loaded;
		return win.isDestroyed() ? null : win;
	}

	/** The driver reports physical screen pixels; windows are placed in DIP. */
	private toDip(point: ScreenPoint | undefined): DipPoint | null {
		if (!point) return null;
		const dip = process.platform === "win32" ? screen.screenToDipPoint(point) : point;
		return { x: Math.round(dip.x), y: Math.round(dip.y) };
	}

	private place(win: BrowserWindow, tip: DipPoint): void {
		this.position = tip;
		win.setBounds({ x: tip.x + TIP_GAP, y: tip.y + TIP_GAP, width: WIDTH, height: HEIGHT });
	}

	private async glide(win: BrowserWindow, to: DipPoint, generation: number, minMs = 0): Promise<void> {
		const from = this.position ?? to;
		const distance = Math.hypot(to.x - from.x, to.y - from.y);
		const duration = Math.max(minMs, Math.min(450, 160 + distance * 0.35));
		if (distance < 1) {
			this.place(win, to);
			return;
		}
		const start = Date.now();
		for (;;) {
			if (generation !== this.generation || win.isDestroyed()) return;
			const t = Math.min(1, (Date.now() - start) / duration);
			// Ease-out cubic: quick to leave, gentle to arrive.
			const k = 1 - (1 - t) ** 3;
			this.place(win, { x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k) });
			if (t >= 1) return;
			await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
		}
	}

	private async run(win: BrowserWindow, script: string): Promise<void> {
		if (win.isDestroyed()) return;
		await win.webContents.executeJavaScript(script).catch(() => undefined);
	}
}
