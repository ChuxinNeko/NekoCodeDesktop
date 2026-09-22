import { BrowserWindow } from "electron";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import darkPlus from "@shikijs/themes/dark-plus";
import langBash from "@shikijs/langs/bash";
import langC from "@shikijs/langs/c";
import langCpp from "@shikijs/langs/cpp";
import langCSharp from "@shikijs/langs/csharp";
import langCss from "@shikijs/langs/css";
import langDiff from "@shikijs/langs/diff";
import langGo from "@shikijs/langs/go";
import langHtml from "@shikijs/langs/html";
import langJava from "@shikijs/langs/java";
import langJavascript from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langJsx from "@shikijs/langs/jsx";
import langMarkdown from "@shikijs/langs/markdown";
import langPhp from "@shikijs/langs/php";
import langPowershell from "@shikijs/langs/powershell";
import langPython from "@shikijs/langs/python";
import langRuby from "@shikijs/langs/ruby";
import langRust from "@shikijs/langs/rust";
import langShellscript from "@shikijs/langs/shellscript";
import langSql from "@shikijs/langs/sql";
import langSwift from "@shikijs/langs/swift";
import langToml from "@shikijs/langs/toml";
import langTsx from "@shikijs/langs/tsx";
import langTypescript from "@shikijs/langs/typescript";
import langVue from "@shikijs/langs/vue";
import langXml from "@shikijs/langs/xml";
import langYaml from "@shikijs/langs/yaml";
import { parseTable, type Renderable } from "./code-blocks";

/**
 * Draw code and tables as pictures, using the Chromium already in this process.
 *
 * An offscreen window rather than a rendering library, because the project
 * already ships both halves: Shiki for the colors and Electron for the raster.
 * Nothing leaves the machine — the bytes go straight to QQ's upload endpoint,
 * which is the whole reason this is not a web service.
 */

/** Wide enough for ~90 columns at this size; QQ scales it down on a phone. */
const WIDTH = 900;
/** Past this a screenshot is unreadable anyway, and the transcript has the rest. */
const MAX_LINES = 60;
const MAX_LINE_CHARS = 400;
/** Rendering is a window; two at once on the same task is not worth the memory. */
let queue: Promise<unknown> = Promise.resolve();

const LANGS = [
	langBash, langC, langCpp, langCSharp, langCss, langDiff, langGo, langHtml, langJava,
	langJavascript, langJson, langJsx, langMarkdown, langPhp, langPowershell, langPython,
	langRuby, langRust, langShellscript, langSql, langSwift, langToml, langTsx, langTypescript,
	langVue, langXml, langYaml,
];

/** What Shiki knows it as, for the aliases models actually write. */
const ALIASES: Record<string, string> = {
	ts: "typescript",
	js: "javascript",
	sh: "shellscript",
	bash: "bash",
	zsh: "shellscript",
	shell: "shellscript",
	console: "shellscript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	kt: "java",
	yml: "yaml",
	md: "markdown",
	"c++": "cpp",
	"c#": "csharp",
	cs: "csharp",
	ps1: "powershell",
	patch: "diff",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
	highlighterPromise ??= createHighlighterCore({
		themes: [darkPlus],
		langs: LANGS,
		engine: createJavaScriptRegexEngine(),
	});
	return highlighterPromise;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Trim to something a single image can show, and say so when it was cut. */
function clip(code: string): { code: string; truncated: boolean } {
	const lines = code.split("\n").map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
	if (lines.length <= MAX_LINES) return { code: lines.join("\n"), truncated: false };
	return { code: lines.slice(0, MAX_LINES).join("\n"), truncated: true };
}

const STYLE = `
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		background: #1e1e1e;
		color: #d4d4d4;
		font: 15px/1.55 "Cascadia Code", "JetBrains Mono", Consolas, "SF Mono", Menlo,
			"Microsoft YaHei", monospace;
		padding: 20px 22px;
		width: ${String(WIDTH)}px;
	}
	pre { white-space: pre-wrap; word-break: break-word; }
	.head {
		color: #808080; font-size: 12px; letter-spacing: .04em;
		margin-bottom: 12px; text-transform: uppercase;
	}
	.cut { color: #808080; font-size: 12px; margin-top: 12px; }
	table { border-collapse: collapse; width: 100%; font-size: 14px; }
	th, td { border: 1px solid #3c3c3c; padding: 7px 11px; text-align: left; word-break: break-word; }
	th { background: #2d2d2d; color: #e6e6e6; font-weight: 600; }
`;

function page(body: string): string {
	// No scripts and nothing remote: the only thing this page does is hold text
	// still long enough to photograph it.
	return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src local;">
<style>${STYLE}</style></head><body>${body}</body></html>`;
}

async function codeBody(block: Renderable): Promise<string> {
	const { code, truncated } = clip(block.content);
	const alias = block.lang?.toLowerCase() ?? "";
	const lang = ALIASES[alias] ?? alias;
	const highlighter = await getHighlighter();
	const known = highlighter.getLoadedLanguages().includes(lang);
	const rendered = known
		? highlighter.codeToHtml(code, { lang, theme: "dark-plus" })
		: `<pre>${escapeHtml(code)}</pre>`;
	return [
		block.lang ? `<div class="head">${escapeHtml(block.lang)}</div>` : "",
		rendered,
		truncated ? `<div class="cut">… 已截断，完整内容请在电脑端查看</div>` : "",
	].join("");
}

function tableBody(block: Renderable): string {
	const rows = parseTable(block.content);
	if (!rows.length) return `<pre>${escapeHtml(block.content)}</pre>`;
	const [header, ...body] = rows;
	const cells = (row: string[], tag: "th" | "td") =>
		row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join("");
	return `<table><thead><tr>${cells(header, "th")}</tr></thead><tbody>${body
		.slice(0, MAX_LINES)
		.map((row) => `<tr>${cells(row, "td")}</tr>`)
		.join("")}</tbody></table>`;
}

/**
 * Photograph one block.
 *
 * Serialized through a queue: each call is a real browser window, and a task
 * that answered with four code blocks would otherwise open four at once.
 */
export function renderBlock(block: Renderable): Promise<Buffer> {
	const run = async () => {
		const html = page(block.kind === "code" ? await codeBody(block) : tableBody(block));
		return rasterize(html);
	};
	const result = queue.then(run, run);
	queue = result.catch(() => undefined);
	return result;
}

async function rasterize(html: string): Promise<Buffer> {
	// Hidden, not `offscreen: true`. An offscreen window paints to a bitmap the
	// compositor will not hand to `capturePage`, which fails with UnknownVizError;
	// a hidden window with `paintWhenInitiallyHidden` renders normally and can be
	// photographed.
	const win = new BrowserWindow({
		width: WIDTH,
		height: 200,
		show: false,
		paintWhenInitiallyHidden: true,
		webPreferences: {
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			// Nothing in the page is an image, and this stops a crafted one from
			// reaching out to fetch anything.
			images: false,
			webSecurity: true,
		},
	});
	try {
		await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		// Measured rather than computed: wrapped long lines and CJK columns make
		// line-counting wrong in exactly the cases that need an image most.
		const height = Math.min(
			4000,
			Math.max(
				80,
				Number(
					await win.webContents.executeJavaScript(
						"Math.ceil(document.body.getBoundingClientRect().height)",
					),
				) || 200,
			),
		);
		win.setContentSize(WIDTH, height);
		// One frame for the resize to land before the shutter.
		await new Promise((resolve) => setTimeout(resolve, 60));
		// Captured at the display's scale factor, so a HiDPI machine produces a
		// sharper image than a 1x one. QQ scales either to fit, and sharper is the
		// direction worth erring in on a phone.
		const image = await win.webContents.capturePage();
		if (image.isEmpty()) throw new Error("截图为空");
		return image.toPNG();
	} finally {
		if (!win.isDestroyed()) win.destroy();
	}
}
