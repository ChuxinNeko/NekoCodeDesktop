import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import { release } from "node:os";
import { join, resolve, sep } from "node:path";
import { AgentService } from "./agent-service";
import { AutomationService } from "./automation/service";
import { installBrowserGuards } from "./browser-service";
import { GitHubAuthService } from "./github-auth";
import { applyAction, getDiff, getStatus, initRepo, listScopeFiles } from "./git";
import { ModelConfigService } from "./model-config-service";
import { PullRequestService } from "./pull-request-service";
import { TerminalService } from "./terminal-service";
import type {
	DeleteSessionRequest,
	ExecutionMode,
	OpenSessionRequest,
	RenameSessionRequest,
	SendPromptRequest,
	ThinkingLevel,
} from "../shared/agent";
import type { GitActionRequest, GitDiffRequest, ReviewScope } from "../shared/git";
import type {
	TerminalCreateRequest,
	TerminalInputRequest,
	TerminalResizeRequest,
} from "../shared/terminal";
import type {
	FetchModelsRequest,
	ModelTestRequest,
	SaveModelProfileRequest,
} from "../shared/settings";
import type { AutomationEvent, SaveAutomationRequest } from "../shared/automation";
import type {
	CreatePullRequestRequest,
	PullRequestFilter,
} from "../shared/pullRequests";
import { TITLE_BAR_HEIGHT, type ShellInfo } from "../shared/window";

// Set before anything reads app.getPath("userData"): launched as
// `electron out/main/index.js` the entry directory has no package.json, so Electron
// would otherwise name the app "Electron" and share that userData directory with
// every other unnamed Electron app on the machine.
app.setName("NekoCode Desktop");

let agentService: AgentService | null = null;
let terminalService: TerminalService | null = null;
let modelConfig: ModelConfigService | null = null;
let automationService: AutomationService | null = null;
let githubAuth: GitHubAuthService | null = null;
let pullRequests: PullRequestService | null = null;

/**
 * First CLI argument that names an existing directory. `electron . <dir>` (or a
 * packaged binary invoked as `nekocode-desktop <dir>`) opens that project
 * directly instead of waiting for the folder picker.
 */
function initialProjectDirectory(): string | null {
	// Chromium's own switches and the entry script both appear in argv, so the
	// project directory is identified by shape instead of position: the first
	// non-flag argument that is an existing directory and is not the app itself.
	const appPath = app.getAppPath();
	for (const argument of process.argv.slice(1)) {
		if (argument.startsWith("-")) continue;
		const candidate = resolve(argument);
		if (candidate === appPath || candidate.startsWith(appPath + sep)) continue;
		if (candidate.endsWith(".js") || candidate.endsWith(".asar")) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// unreadable path; keep looking
		}
	}
	return null;
}

/**
 * `backgroundMaterial` only does anything from Windows 11 22H2 (build 22621) on.
 * Below that the transparent window background Mica needs would paint plain
 * black, so those builds keep the opaque shell.
 */
function supportsMica(): boolean {
	if (process.platform !== "win32") return false;
	const build = Number(release().split(".")[2]);
	return Number.isFinite(build) && build >= 22621;
}

const shellInfo: ShellInfo = {
	backdrop: supportsMica() ? "mica" : "none",
	titleBarHeight: TITLE_BAR_HEIGHT,
};

/**
 * The caption glyphs are drawn by Windows, not by us, so they only get a single
 * color. Follow the resolved system theme, which the renderer keeps in sync
 * through `theme:set`.
 */
function captionOverlay() {
	return {
		// Transparent so the title bar row behind the buttons (and the Mica
		// material behind that) shows through instead of a flat patch of color.
		color: "#00000000",
		symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1a1a19",
		height: TITLE_BAR_HEIGHT,
	};
}

function createWindow(): void {
	const mica = shellInfo.backdrop === "mica";
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1100,
		minHeight: 700,
		title: "NekoCode Desktop",
		// Mica is composited behind the window by DWM, so the window's own
		// background has to be fully transparent for it to show at all.
		backgroundColor: mica
			? "#00000000"
			: nativeTheme.shouldUseDarkColors
				? "#1a1a19"
				: "#f9f9f7",
		...(mica ? { backgroundMaterial: "mica" as const } : {}),
		// The app draws its own caption strip. `hidden` rather than `frame: false`
		// so Windows still gives the window its rounded corners, drop shadow and
		// resize borders; the caption buttons stay system-drawn (below) so Snap
		// Layouts keeps working.
		titleBarStyle:
			process.platform === "darwin"
				? "hiddenInset"
				: process.platform === "win32"
					? "hidden"
					: "default",
		...(process.platform === "win32" ? { titleBarOverlay: captionOverlay() } : {}),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// The browser panel hosts its pages in renderer-owned <webview> guests;
			// installBrowserGuards() pins their web preferences.
			webviewTag: true,
		},
	});

	installBrowserGuards(win);

	if (process.platform === "win32") {
		// Repaint the caption glyphs when the app flips light/dark, otherwise they
		// stay in the color they had when the window opened.
		const syncOverlay = () => {
			if (!win.isDestroyed()) win.setTitleBarOverlay(captionOverlay());
		};
		nativeTheme.on("updated", syncOverlay);
		win.on("closed", () => nativeTheme.off("updated", syncOverlay));
	}

	if (!modelConfig) modelConfig = new ModelConfigService();
	agentService = new AgentService(win, modelConfig);
	terminalService = new TerminalService(win);

	if (!githubAuth) githubAuth = new GitHubAuthService();
	if (!pullRequests) pullRequests = new PullRequestService(githubAuth);
	if (!automationService) {
		automationService = new AutomationService({
			userDataDir: app.getPath("userData"),
			// Automation runs get their own session directory: a run creates a PI
			// session, and sharing the interactive directory would make every
			// scheduled run show up as a session in the sidebar.
			sessionsDir: join(app.getPath("userData"), "automation-sessions"),
			getModelRuntime: async () => {
				if (!agentService) throw new Error("Agent service is not running");
				return agentService.getModelRuntime();
			},
			onEvent: (event: AutomationEvent) => {
				if (!win.isDestroyed()) win.webContents.send("automation:event", event);
			},
		});
		automationService.start();
	}

	win.on("closed", () => {
		terminalService?.killAll();
		agentService?.close();
		agentService = null;
		terminalService = null;
	});

	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void win.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

function registerIpc(): void {
	ipcMain.handle("app:initialProjectDir", () => initialProjectDirectory());

	// Synchronous on purpose: the preload reads this once at load time so the
	// theme can pick its shell material before the first paint, with no flash of
	// the wrong background.
	ipcMain.on("app:shellInfo", (event) => {
		event.returnValue = shellInfo;
	});

	// Also synchronous: it is the default working directory, so the welcome
	// screen needs it in its first render rather than a tick later.
	ipcMain.on("app:homeDir", (event) => {
		event.returnValue = app.getPath("home");
	});

	ipcMain.handle("browser:openExternal", (_event, url: string) => {
		if (!/^https?:\/\//i.test(url)) {
			throw new Error(`Refusing to open non-http(s) URL: ${url}`);
		}
		return shell.openExternal(url);
	});

	ipcMain.handle("theme:set", (_event, theme: "light" | "dark" | "system") => {
		if (theme === "light" || theme === "dark" || theme === "system") {
			nativeTheme.themeSource = theme;
		}
	});

	ipcMain.handle("git:status", (_e, cwd: string) => getStatus(cwd));
	ipcMain.handle("git:diff", (_e, req: GitDiffRequest) => getDiff(req));
	ipcMain.handle("git:files", (_e, cwd: string, scope: ReviewScope) =>
		listScopeFiles(cwd, scope),
	);
	ipcMain.handle("git:action", (_e, req: GitActionRequest) => applyAction(req));
	ipcMain.handle("git:init", (_e, cwd: string) => initRepo(cwd));
	ipcMain.handle("dialog:openDirectory", async (e) => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win) return null;
		const result = await dialog.showOpenDialog(win, {
			properties: ["openDirectory"],
			title: "打开项目目录",
		});
		return result.canceled ? null : result.filePaths[0];
	});

	ipcMain.handle("agent:listSessions", (_e, cwd: string) =>
		agentService?.listSessions(cwd),
	);
	ipcMain.handle("agent:create", (_e, cwd: string) =>
		agentService?.createSession(cwd),
	);
	ipcMain.handle("agent:open", (_e, req: OpenSessionRequest) =>
		agentService?.openSession(req),
	);
	ipcMain.handle("agent:rename", (_e, req: RenameSessionRequest) =>
		agentService?.renameSession(req),
	);
	ipcMain.handle("agent:delete", (_e, req: DeleteSessionRequest) =>
		agentService?.deleteSession(req),
	);
	ipcMain.handle("agent:snapshot", () => agentService?.getSnapshot() ?? null);
	ipcMain.handle("agent:defaults", (_e, cwd: string) =>
		agentService?.getDefaults(cwd),
	);
	ipcMain.handle("agent:send", (_e, req: SendPromptRequest) =>
		agentService?.send(req),
	);
	ipcMain.handle("agent:abort", () => agentService?.abort());
	ipcMain.handle("agent:setModel", (_e, modelKey: string) =>
		agentService?.setModel(modelKey),
	);
	ipcMain.handle("agent:setThinking", (_e, level: ThinkingLevel) =>
		agentService?.setThinkingLevel(level),
	);
	ipcMain.handle("agent:setMode", (_e, mode: ExecutionMode) =>
		agentService?.setMode(mode),
	);

	ipcMain.handle("terminal:create", (_e, req: TerminalCreateRequest) =>
		terminalService?.create(req),
	);
	ipcMain.handle("terminal:input", (_e, req: TerminalInputRequest) =>
		terminalService?.write(req),
	);
	ipcMain.handle("terminal:resize", (_e, req: TerminalResizeRequest) =>
		terminalService?.resize(req),
	);
	ipcMain.handle("terminal:kill", (_e, id: string) => terminalService?.kill(id));

	ipcMain.handle("settings:modelStatus", () => modelConfig?.status());
	ipcMain.handle("settings:listModels", () => modelConfig?.list());
	ipcMain.handle("settings:saveModel", async (_e, req: SaveModelProfileRequest) => {
		const summary = modelConfig?.save(req);
		await agentService?.reloadConfiguredModels();
		return summary;
	});
	ipcMain.handle("settings:deleteModel", async (_e, id: string) => {
		modelConfig?.delete(id);
		await agentService?.reloadConfiguredModels();
	});
	ipcMain.handle("settings:fetchModels", (_e, req: FetchModelsRequest) =>
		modelConfig?.fetchModels(req),
	);
	ipcMain.handle("settings:testModel", (_e, req: ModelTestRequest) =>
		agentService?.testConfiguredModel(req),
	);

	ipcMain.handle("github:status", () => githubAuth?.status());
	ipcMain.handle("github:save", (_e, token: string) => {
		if (!githubAuth) throw new Error("GitHub auth service unavailable");
		return githubAuth.save(token);
	});
	ipcMain.handle("github:clear", () => githubAuth?.clear());

	ipcMain.handle("pr:list", (_e, cwd: string, filter: PullRequestFilter) =>
		pullRequests?.list(cwd, filter),
	);
	ipcMain.handle("pr:detail", (_e, cwd: string, number: number) =>
		pullRequests?.detail(cwd, number),
	);
	ipcMain.handle("pr:branches", (_e, cwd: string) => pullRequests?.branches(cwd));
	ipcMain.handle("pr:create", (_e, req: CreatePullRequestRequest) =>
		pullRequests?.create(req),
	);

	ipcMain.handle("automation:list", () => automationService?.list() ?? []);
	ipcMain.handle("automation:get", (_e, id: string) => automationService?.get(id) ?? null);
	ipcMain.handle("automation:runs", (_e, id: string) => automationService?.runs(id) ?? []);
	ipcMain.handle("automation:save", (_e, req: SaveAutomationRequest) => {
		if (!automationService) throw new Error("Automation service unavailable");
		return automationService.save(req);
	});
	ipcMain.handle("automation:remove", (_e, id: string) => automationService?.remove(id));
	ipcMain.handle("automation:runNow", (_e, id: string) => {
		if (!automationService) throw new Error("Automation service unavailable");
		return automationService.runNow(id);
	});
	ipcMain.handle("automation:abort", (_e, id: string) => automationService?.abort(id));
}

app.whenReady().then(() => {
	if (process.platform !== "darwin") Menu.setApplicationMenu(null);
	registerIpc();
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("before-quit", () => {
	automationService?.stop();
	terminalService?.killAll();
	agentService?.close();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
