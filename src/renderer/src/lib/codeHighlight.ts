// FILE: codeHighlight.ts
// Purpose: Shiki-based syntax highlighting for the dock file preview.
// Layer: web UI utility
// Exports: highlightFileToHtml
// Depends on: shiki (JS regex engine — no WASM, safe under file://), VS Code's
//   bundled light-plus/dark-plus themes so colors track the real editor.

import { createHighlighterCore, type HighlighterCore, type LanguageInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";

/** Filename matches win over extensions (lowercased). */
const NAME_TO_LANG: Record<string, string> = {
	dockerfile: "dockerfile",
	"docker-compose.yml": "yaml",
	"docker-compose.yaml": "yaml",
	makefile: "makefile",
	"cmakelists.txt": "cmake",
	".gitignore": "ini",
	".gitattributes": "ini",
	".gitmodules": "ini",
	".editorconfig": "ini",
};

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	json: "json",
	jsonc: "jsonc",
	json5: "json5",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	vue: "vue",
	svelte: "svelte",
	md: "markdown",
	mdx: "mdx",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	rb: "ruby",
	php: "php",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	cs: "csharp",
	dart: "dart",
	lua: "lua",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	ps1: "powershell",
	bat: "bat",
	cmd: "bat",
	sql: "sql",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	xml: "xml",
	env: "dotenv",
	ini: "ini",
	cfg: "ini",
	diff: "diff",
	patch: "diff",
	graphql: "graphql",
	gql: "graphql",
	cmake: "cmake",
};

/** Null means "render as plain text" — unknown extension or dotfile-only name. */
function langForFile(name: string): string | null {
	const lower = name.toLowerCase();
	const byName = NAME_TO_LANG[lower];
	if (byName) return byName;
	const dot = lower.lastIndexOf(".");
	if (dot <= 0) return null;
	return EXT_TO_LANG[lower.slice(dot + 1)] ?? null;
}

/**
 * Grammars by Shiki language id, loaded on first use.
 *
 * Compiling a grammar is the expensive part of highlighting — all of these at
 * once cost the first file edit on screen about half a second of blocked
 * renderer. Loaded one at a time as a transcript actually shows that language,
 * each is paid once, and the ones a project never uses are never paid at all.
 */
const LANG_LOADERS: Record<string, () => Promise<{ default: LanguageInput }>> = {
	bash: () => import("@shikijs/langs/bash"),
	bat: () => import("@shikijs/langs/bat"),
	c: () => import("@shikijs/langs/c"),
	cmake: () => import("@shikijs/langs/cmake"),
	cpp: () => import("@shikijs/langs/cpp"),
	csharp: () => import("@shikijs/langs/csharp"),
	css: () => import("@shikijs/langs/css"),
	dart: () => import("@shikijs/langs/dart"),
	diff: () => import("@shikijs/langs/diff"),
	dockerfile: () => import("@shikijs/langs/dockerfile"),
	dotenv: () => import("@shikijs/langs/dotenv"),
	go: () => import("@shikijs/langs/go"),
	graphql: () => import("@shikijs/langs/graphql"),
	html: () => import("@shikijs/langs/html"),
	ini: () => import("@shikijs/langs/ini"),
	java: () => import("@shikijs/langs/java"),
	javascript: () => import("@shikijs/langs/javascript"),
	json: () => import("@shikijs/langs/json"),
	json5: () => import("@shikijs/langs/json5"),
	jsonc: () => import("@shikijs/langs/jsonc"),
	jsx: () => import("@shikijs/langs/jsx"),
	kotlin: () => import("@shikijs/langs/kotlin"),
	less: () => import("@shikijs/langs/less"),
	lua: () => import("@shikijs/langs/lua"),
	makefile: () => import("@shikijs/langs/makefile"),
	markdown: () => import("@shikijs/langs/markdown"),
	mdx: () => import("@shikijs/langs/mdx"),
	php: () => import("@shikijs/langs/php"),
	powershell: () => import("@shikijs/langs/powershell"),
	python: () => import("@shikijs/langs/python"),
	ruby: () => import("@shikijs/langs/ruby"),
	rust: () => import("@shikijs/langs/rust"),
	scss: () => import("@shikijs/langs/scss"),
	shellscript: () => import("@shikijs/langs/shellscript"),
	sql: () => import("@shikijs/langs/sql"),
	svelte: () => import("@shikijs/langs/svelte"),
	swift: () => import("@shikijs/langs/swift"),
	toml: () => import("@shikijs/langs/toml"),
	tsx: () => import("@shikijs/langs/tsx"),
	typescript: () => import("@shikijs/langs/typescript"),
	vue: () => import("@shikijs/langs/vue"),
	xml: () => import("@shikijs/langs/xml"),
	yaml: () => import("@shikijs/langs/yaml"),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
	highlighterPromise ??= createHighlighterCore({
		themes: [lightPlus, darkPlus],
		langs: [],
		engine: createJavaScriptRegexEngine(),
	});
	return highlighterPromise;
}

function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<void> {
	let load = languageLoads.get(lang);
	if (!load) {
		const loader = LANG_LOADERS[lang];
		load = loader
			? loader().then((module) => highlighter.loadLanguage(module.default))
			: Promise.reject(new Error(`No grammar for ${lang}`));
		languageLoads.set(lang, load);
	}
	return load;
}

/**
 * Highlight a file's text into Shiki HTML (`.shiki` pre + `.line` spans), dual
 * light-plus/dark-plus output via `--shiki-*` CSS vars — `.dark` on the root
 * flips which var each token reads, so one HTML string serves both themes.
 * Returns null for unrecognized file types; callers render the plain fallback.
 */
export async function highlightFileToHtml(
	code: string,
	filename: string,
): Promise<string | null> {
	const lang = langForFile(filename);
	if (!lang) return null;
	const highlighter = await getHighlighter();
	await ensureLanguage(highlighter, lang);
	return highlighter.codeToHtml(code, {
		lang,
		themes: { light: "light-plus", dark: "dark-plus" },
		defaultColor: false,
	});
}

interface HighlightJob {
	code: string;
	filename: string;
	signal: AbortSignal;
	resolve: (html: string | null) => void;
	reject: (error: unknown) => void;
}

const highlightQueue: HighlightJob[] = [];
let highlightDraining = false;

const whenIdle = (callback: () => void) => {
	if (typeof requestIdleCallback === "function") requestIdleCallback(callback, { timeout: 500 });
	else setTimeout(callback, 16);
};

function drainHighlights(): void {
	if (highlightDraining) return;
	highlightDraining = true;
	whenIdle(() => {
		let job = highlightQueue.shift();
		while (job?.signal.aborted) job = highlightQueue.shift();
		const finish = () => {
			highlightDraining = false;
			if (highlightQueue.length > 0) drainHighlights();
		};
		if (!job) return finish();
		const current = job;
		highlightFileToHtml(current.code, current.filename)
			.then(current.resolve, current.reject)
			.finally(finish);
	});
}

/**
 * {@link highlightFileToHtml}, one file at a time and only when the renderer
 * is idle.
 *
 * Opening a session mounts every edit in it at once; tokenizing them all in
 * the same task is a frame the user sees freeze. Queued, each one waits for a
 * gap between frames, and one that is no longer wanted by the time its turn
 * comes (the row unmounted, the text moved on) is skipped for free.
 */
export function highlightWhenIdle(code: string, filename: string, signal: AbortSignal): Promise<string | null> {
	return new Promise((resolve, reject) => {
		highlightQueue.push({ code, filename, signal, resolve, reject });
		drainHighlights();
	});
}
