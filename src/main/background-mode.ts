import type { WindowCloseBehavior } from "../shared/preferences";

interface BackgroundWindow {
	isDestroyed(): boolean;
	isMinimized(): boolean;
	isVisible(): boolean;
	restore(): void;
	show(): void;
	focus(): void;
	hide(): void;
	minimize(): void;
}

interface TrayHandle { destroy(): void }

/** Owns close-to-tray decisions independently of the native window and its services. */
export class BackgroundMode {
	private tray: TrayHandle | null = null;
	private behavior: WindowCloseBehavior = "quit";
	private quitting = false;
	constructor(private readonly options: {
		getWindow: () => BackgroundWindow | null;
		createWindow: () => void;
		createTray: (actions: { show: () => void; quit: () => void }) => TrayHandle;
		quit: () => void;
		onTrayError: (error: unknown) => void;
	}) {}

	/** Prepare before persisting the preference so failures leave the previous choice intact. */
	ensureTray(): void {
		if (this.quitting || this.tray) return;
		this.tray = this.options.createTray({ show: () => this.showWindow(), quit: () => this.requestQuit() });
	}

	setBehavior(behavior: WindowCloseBehavior): void {
		if (behavior === "tray") this.ensureTray();
		this.behavior = behavior;
		if (behavior === "quit" && this.tray) {
			// A change arriving through the WebUI must not strand a hidden window.
			const window = this.options.getWindow();
			if (window && !window.isDestroyed() && !window.isVisible()) this.showWindow();
			this.destroyTray();
		}
	}

	/** Startup still honors the saved choice if the desktop temporarily has no tray. */
	loadBehavior(behavior: WindowCloseBehavior): void {
		this.behavior = behavior;
		try { this.setBehavior(behavior); } catch (error) { this.options.onTrayError(error); }
	}

	handleClose(event: { preventDefault(): void }): void {
		if (this.quitting) return;
		if (this.behavior === "quit") {
			this.requestQuit();
			return;
		}
		const window = this.options.getWindow();
		if (!window || window.isDestroyed()) return;
		event.preventDefault();
		try {
			this.ensureTray();
			window.hide();
		} catch (error) {
			// Keep a taskbar/dock entry rather than hiding without a way back.
			this.options.onTrayError(error);
			window.minimize();
		}
	}

	showWindow(): void {
		if (this.quitting) return;
		const window = this.options.getWindow();
		if (!window || window.isDestroyed()) { this.options.createWindow(); return; }
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	}

	requestQuit(): void {
		if (this.quitting) return;
		this.beginQuit();
		this.options.quit();
	}

	/** Explicit Quit, updates and OS shutdown must bypass the close interceptor. */
	beginQuit(): void {
		this.quitting = true;
		this.destroyTray();
	}

	private destroyTray(): void {
		const tray = this.tray;
		this.tray = null;
		tray?.destroy();
	}
}
