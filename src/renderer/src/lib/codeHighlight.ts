// FILE: codeHighlight.ts
// Purpose: Shiki-based syntax highlighting for the dock file preview.
// Layer: web UI utility
// Exports: highlightFileToHtml
// Depends on: shiki (JS regex engine — no WASM, safe under file://), VS Code's
//   bundled light-plus/dark-plus themes so colors track the real editor.

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";

import langBash from "@shikijs/langs/bash";
import langBat from "@shikijs/langs/bat";
import langC from "@shikijs/langs/c";
import langCMake from "@shikijs/langs/cmake";
import langCpp from "@shikijs/langs/cpp";
import langCSharp from "@shikijs/langs/csharp";
import langCss from "@shikijs/langs/css";
import langDart from "@shikijs/langs/dart";
import langDiff from "@shikijs/langs/diff";
import langDockerfile from "@shikijs/langs/dockerfile";
import langDotenv from "@shikijs/langs/dotenv";
import langGo from "@shikijs/langs/go";
import langGraphql from "@shikijs/langs/graphql";
import langHtml from "@shikijs/langs/html";
import langIni from "@shikijs/langs/ini";
import langJava from "@shikijs/langs/java";
import langJavascript from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langJson5 from "@shikijs/langs/json5";
import langJsonc from "@shikijs/langs/jsonc";
import langJsx from "@shikijs/langs/jsx";
import langKotlin from "@shikijs/langs/kotlin";
import langLess from "@shikijs/langs/less";
import langLua from "@shikijs/langs/lua";
import langMakefile from "@shikijs/langs/makefile";
import langMarkdown from "@shikijs/langs/markdown";
import langMdx from "@shikijs/langs/mdx";
import langPhp from "@shikijs/langs/php";
import langPowershell from "@shikijs/langs/powershell";
import langPython from "@shikijs/langs/python";
import langRuby from "@shikijs/langs/ruby";
import langRust from "@shikijs/langs/rust";
import langScss from "@shikijs/langs/scss";
import langShellscript from "@shikijs/langs/shellscript";
import langSql from "@shikijs/langs/sql";
import langSvelte from "@shikijs/langs/svelte";
import langSwift from "@shikijs/langs/swift";
import langToml from "@shikijs/langs/toml";
import langTsx from "@shikijs/langs/tsx";
import langTypescript from "@shikijs/langs/typescript";
import langVue from "@shikijs/langs/vue";
import langXml from "@shikijs/langs/xml";
import langYaml from "@shikijs/langs/yaml";

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

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
	highlighterPromise ??= createHighlighterCore({
		themes: [lightPlus, darkPlus],
		langs: [
			langBash,
			langBat,
			langC,
			langCMake,
			langCpp,
			langCSharp,
			langCss,
			langDart,
			langDiff,
			langDockerfile,
			langDotenv,
			langGo,
			langGraphql,
			langHtml,
			langIni,
			langJava,
			langJavascript,
			langJson,
			langJson5,
			langJsonc,
			langJsx,
			langKotlin,
			langLess,
			langLua,
			langMakefile,
			langMarkdown,
			langMdx,
			langPhp,
			langPowershell,
			langPython,
			langRuby,
			langRust,
			langScss,
			langShellscript,
			langSql,
			langSvelte,
			langSwift,
			langToml,
			langTsx,
			langTypescript,
			langVue,
			langXml,
			langYaml,
		],
		engine: createJavaScriptRegexEngine(),
	});
	return highlighterPromise;
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
	return highlighter.codeToHtml(code, {
		lang,
		themes: { light: "light-plus", dark: "dark-plus" },
		defaultColor: false,
	});
}
