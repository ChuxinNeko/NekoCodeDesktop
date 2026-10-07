import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import {
	ART_MIME_BY_EXTENSION,
	MAX_THEME_PACKAGE_BYTES,
	THEME_PACKAGE_EXTENSION,
	THEMES_DIR_ENV,
	isThemeId,
	parseThemePackage,
	readCommunityTheme,
	type CommunityTheme,
	type ThemeLibraryChange,
	type ThemeLibrarySnapshot,
} from "../shared/themes";

/**
 * The community themes installed on this machine: one folder per theme under
 * `~/.nekocode/themes`, holding its manifest and artwork.
 *
 * The folder doubles as a drop box. A `.codex-theme` package written into it —
 * by the agent, following the bundled theme skill, or by hand — is installed
 * and removed, and the window is told so it can apply the theme. That is what
 * lets "install theme X from codexthemes.ai" work as a prompt: the agent only
 * has to download a file, never reach into this app's settings.
 */

const MANIFEST = "theme.json";
/** A download still being written is left alone until it has been quiet this long. */
const SETTLE_MS = 1_500;
const WATCH_DEBOUNCE_MS = 300;

/** `~/.nekocode/themes`, beside the agent directory so isolated runs move it too. */
export function resolveThemesDir(env: NodeJS.ProcessEnv = process.env, agentDir: string): string {
	return env[THEMES_DIR_ENV]?.trim() || join(dirname(agentDir), "themes");
}

export class ThemeLibrary {
	private watcher: FSWatcher | null = null;
	private timer: NodeJS.Timeout | null = null;
	private listeners = new Set<(change: ThemeLibraryChange) => void>();

	constructor(
		readonly dir: string,
		/** Moves a removed theme's folder somewhere recoverable — the recycle bin. */
		private trash: (path: string) => Promise<void>,
	) {}

	snapshot(): ThemeLibrarySnapshot {
		let entries: string[] = [];
		try {
			entries = readdirSync(this.dir);
		} catch {
			// Not created yet: nothing installed.
		}
		const themes: CommunityTheme[] = [];
		for (const entry of entries) {
			if (!isThemeId(entry)) continue;
			const theme = this.read(entry);
			if (theme) themes.push(theme);
		}
		return { dir: this.dir, themes: themes.sort((a, b) => a.name.localeCompare(b.name)) };
	}

	private read(id: string): CommunityTheme | null {
		try {
			const manifest = JSON.parse(readFileSync(join(this.dir, id, MANIFEST), "utf8"));
			const theme = readCommunityTheme({ ...manifest, id }, false);
			return { ...theme, art: this.artPath(id, manifest) !== null };
		} catch {
			return null;
		}
	}

	/**
	 * The artwork beside a manifest. A theme copied in from the codexthemes
	 * skills' own folder keeps the manifest's path (`assets/artwork.jpg`) while
	 * its installer wrote the bare file name, so both are tried.
	 */
	private artPath(id: string, manifest: { art?: unknown }): string | null {
		if (typeof manifest.art !== "string" || !manifest.art) return null;
		const root = join(this.dir, id);
		const relative = manifest.art.replace(/\\/g, "/");
		if (relative.split("/").some((part) => part === "..")) return null;
		for (const candidate of [join(root, relative), join(root, relative.split("/").pop() ?? "")]) {
			const extension = candidate.split(".").pop()?.toLowerCase() ?? "";
			if (!ART_MIME_BY_EXTENSION[extension]) continue;
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// try the next
			}
		}
		return null;
	}

	/** Install a package, replacing an installed theme of the same id. */
	install(source: string): CommunityTheme {
		const parsed = parseThemePackage(source);
		return this.replace(parsed.theme, parsed.manifest, parsed.art ? { name: parsed.art.fileName, data: Buffer.from(parsed.art.base64, "base64") } : null);
	}

	/** Import an already-extracted theme folder containing theme.json. */
	installDirectory(sourceDir: string): CommunityTheme {
		let manifest: Record<string, unknown>;
		try {
			if (!statSync(sourceDir).isDirectory()) throw new Error("选择的路径不是主题文件夹");
			manifest = JSON.parse(readFileSync(join(sourceDir, MANIFEST), "utf8"));
		} catch (error) {
			if (error instanceof Error && error.message === "选择的路径不是主题文件夹") throw error;
			throw new Error("主题文件夹缺少有效的 theme.json");
		}
		const theme = readCommunityTheme(manifest, false);
		let artwork: { name: string; data: Buffer } | null = null;
		if (typeof manifest.art === "string" && manifest.art) {
			const relative = manifest.art.replace(/\\/g, "/");
			if (relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("主题插画路径无效");
			const candidates = [join(sourceDir, relative), join(sourceDir, relative.split("/").pop() ?? "")];
			for (const candidate of candidates) {
				const extension = candidate.split(".").pop()?.toLowerCase() ?? "";
				if (!ART_MIME_BY_EXTENSION[extension]) continue;
				try {
					if (statSync(candidate).isFile()) {
						artwork = { name: `art.${extension === "jpeg" ? "jpg" : extension}`, data: readFileSync(candidate) };
						break;
					}
				} catch {}
			}
			if (!artwork) throw new Error("主题插画文件不存在或格式不支持");
		}
		const normalized: Record<string, unknown> = { ...manifest, id: theme.id };
		delete normalized.css;
		if (artwork) normalized.art = artwork.name;
		else delete normalized.art;
		return this.replace({ ...theme, art: !!artwork }, normalized, artwork);
	}

	private replace(theme: CommunityTheme, manifest: Record<string, unknown>, artwork: { name: string; data: Buffer } | null): CommunityTheme {
		const { id } = theme;
		mkdirSync(this.dir, { recursive: true });
		const target = join(this.dir, id);
		const staging = join(this.dir, `.${id}.installing-${process.pid}`);
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(staging);
		try {
			writeFileSync(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
			if (artwork) writeFileSync(join(staging, artwork.name), artwork.data);
			rmSync(target, { recursive: true, force: true });
			renameSync(staging, target);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			throw error;
		}
		return theme;
	}

	/** The artwork as a data URL, or null when the theme has none. */
	art(id: string): string | null {
		if (!isThemeId(id)) return null;
		try {
			const manifest = JSON.parse(readFileSync(join(this.dir, id, MANIFEST), "utf8"));
			const path = this.artPath(id, manifest);
			if (!path) return null;
			const mime = ART_MIME_BY_EXTENSION[path.split(".").pop()?.toLowerCase() ?? ""];
			return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
		} catch {
			return null;
		}
	}

	async remove(id: string): Promise<ThemeLibrarySnapshot> {
		if (!isThemeId(id)) throw new Error(`主题 id 无效：${id}`);
		const target = join(this.dir, id);
		if (existsSync(target)) await this.trash(target);
		return this.snapshot();
	}

	/**
	 * Install every package waiting in the folder. A package that fails is
	 * renamed `.failed` with the reason in a `.error.txt` beside it, so it is
	 * not retried forever and whoever dropped it can read why.
	 */
	processDropped(now = Date.now()): { installed: string[]; pending: boolean } {
		const installed: string[] = [];
		let pending = false;
		let entries: string[] = [];
		try {
			entries = readdirSync(this.dir);
		} catch {
			return { installed, pending };
		}
		for (const entry of entries) {
			if (!entry.toLowerCase().endsWith(THEME_PACKAGE_EXTENSION)) continue;
			const path = join(this.dir, entry);
			let size: number;
			try {
				const stat = statSync(path);
				if (!stat.isFile()) continue;
				if (now - stat.mtimeMs < SETTLE_MS) {
					pending = true;
					continue;
				}
				size = stat.size;
			} catch {
				continue;
			}
			try {
				if (size > MAX_THEME_PACKAGE_BYTES) throw new Error("主题包超过 30 MB");
				installed.push(this.install(readFileSync(path, "utf8")).id);
				rmSync(path, { force: true });
				rmSync(`${path}.error.txt`, { force: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				try {
					writeFileSync(`${path}.error.txt`, `${message}\n`);
					renameSync(path, `${path}.failed`);
				} catch {
					// Left in place; the next pass reports it again.
				}
			}
		}
		return { installed, pending };
	}

	onChange(listener: (change: ThemeLibraryChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(installed: string[]): void {
		const change = { snapshot: this.snapshot(), installed };
		for (const listener of this.listeners) listener(change);
	}

	/** Watch the folder: install what is dropped in, report what was added or removed. */
	start(): void {
		mkdirSync(this.dir, { recursive: true });
		this.pass();
		try {
			this.watcher = watch(this.dir, () => this.schedule(WATCH_DEBOUNCE_MS));
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = null;
			});
		} catch {
			// No watching on this filesystem; packages are still picked up at the next launch.
		}
	}

	private schedule(delay: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.pass();
		}, delay);
	}

	private pass(): void {
		const { installed, pending } = this.processDropped();
		if (pending) this.schedule(SETTLE_MS);
		this.emit(installed);
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.watcher?.close();
		this.watcher = null;
	}
}
