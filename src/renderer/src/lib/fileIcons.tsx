// FILE: fileIcons.tsx
// Purpose: Map file names to real file-type icons (brand glyphs + brand colors).
// Layer: web UI utility
// Exports: FileTypeIcon
// Depends on: react-icons (Simple Icons / Devicons / Tabler), shared FileIcon fallback.

import type { ComponentType, CSSProperties } from "react";
import { DiCss3, DiDart, DiJava, DiTerminal } from "react-icons/di";
import {
	SiC,
	SiCplusplus,
	SiDocker,
	SiEslint,
	SiGit,
	SiGnubash,
	SiGo,
	SiGraphql,
	SiHtml5,
	SiJavascript,
	SiJson,
	SiJsonwebtokens,
	SiKotlin,
	SiLess,
	SiLua,
	SiMarkdown,
	SiMongodb,
	SiMysql,
	SiNodedotjs,
	SiNpm,
	SiOpenjdk,
	SiPhp,
	SiPostgresql,
	SiPrettier,
	SiPython,
	SiReact,
	SiRedis,
	SiRuby,
	SiRust,
	SiSass,
	SiSqlite,
	SiSvelte,
	SiSvg,
	SiSwift,
	SiTailwindcss,
	SiToml,
	SiTypescript,
	SiVite,
	SiVuedotjs,
	SiYaml,
} from "react-icons/si";
import {
	TbCertificate,
	TbFileTypePdf,
	TbFileZip,
	TbLock,
	TbMusic,
	TbPhoto,
	TbSql,
	TbVideo,
} from "react-icons/tb";
import { FileIcon } from "./icons";

type FileIconComponent = ComponentType<{ className?: string; style?: CSSProperties }>;

interface FileIconSpec {
	Icon: FileIconComponent;
	/** Brand color — react-icons paint currentColor, so a `color` style tints the glyph. */
	color: string;
}

const spec = (Icon: FileIconComponent, color: string): FileIconSpec => ({ Icon, color });

/** Exact filename matches win over extensions (lowercased lookup). */
const NAME_ICONS: Record<string, FileIconSpec> = {
	"dockerfile": spec(SiDocker, "#2496ED"),
	"docker-compose.yml": spec(SiDocker, "#2496ED"),
	"docker-compose.yaml": spec(SiDocker, "#2496ED"),
	"package.json": spec(SiNpm, "#CB3837"),
	"package-lock.json": spec(SiNpm, "#CB3837"),
	"tsconfig.json": spec(SiTypescript, "#3178C6"),
	".gitignore": spec(SiGit, "#F05032"),
	".gitattributes": spec(SiGit, "#F05032"),
	".gitmodules": spec(SiGit, "#F05032"),
	"license": spec(TbCertificate, "#71717a"),
	"license.md": spec(TbCertificate, "#71717a"),
	"license.txt": spec(TbCertificate, "#71717a"),
	"makefile": spec(DiTerminal, "#427819"),
	"cmakelists.txt": spec(TbCertificate, "#064F8C"),
};

/** Filename prefix matches (lowered): ".env.local", "eslint.config.mjs", … */
const NAME_PREFIX_ICONS: ReadonlyArray<readonly [string, FileIconSpec]> = [
	[".env", spec(TbLock, "#EAB308")],
	["vite.config.", spec(SiVite, "#646CFF")],
	["tailwind.config.", spec(SiTailwindcss, "#06B6D4")],
	["eslint.config.", spec(SiEslint, "#4B32C3")],
	[".eslintrc", spec(SiEslint, "#4B32C3")],
	["prettier.config.", spec(SiPrettier, "#F7B93E")],
	[".prettierrc", spec(SiPrettier, "#F7B93E")],
	["docker-compose.", spec(SiDocker, "#2496ED")],
];

const EXT_ICONS: Record<string, FileIconSpec> = {
	// Web
	html: spec(SiHtml5, "#E34F26"),
	htm: spec(SiHtml5, "#E34F26"),
	css: spec(DiCss3, "#1572B6"),
	scss: spec(SiSass, "#CC6699"),
	sass: spec(SiSass, "#CC6699"),
	less: spec(SiLess, "#1D365D"),
	js: spec(SiJavascript, "#F7DF1E"),
	mjs: spec(SiJavascript, "#F7DF1E"),
	cjs: spec(SiJavascript, "#F7DF1E"),
	jsx: spec(SiReact, "#61DAFB"),
	ts: spec(SiTypescript, "#3178C6"),
	mts: spec(SiTypescript, "#3178C6"),
	cts: spec(SiTypescript, "#3178C6"),
	tsx: spec(SiReact, "#61DAFB"),
	vue: spec(SiVuedotjs, "#4FC08D"),
	svelte: spec(SiSvelte, "#FF3E00"),
	svg: spec(SiSvg, "#FFB13B"),
	graphql: spec(SiGraphql, "#E10098"),
	gql: spec(SiGraphql, "#E10098"),

	// Languages
	py: spec(SiPython, "#3776AB"),
	rs: spec(SiRust, "#DEA584"),
	go: spec(SiGo, "#00ADD8"),
	java: spec(DiJava, "#007396"),
	kt: spec(SiKotlin, "#7F52FF"),
	kts: spec(SiKotlin, "#7F52FF"),
	rb: spec(SiRuby, "#CC342D"),
	php: spec(SiPhp, "#777BB4"),
	swift: spec(SiSwift, "#F05138"),
	c: spec(SiC, "#A8B9CC"),
	h: spec(SiC, "#A8B9CC"),
	cpp: spec(SiCplusplus, "#00599C"),
	cc: spec(SiCplusplus, "#00599C"),
	cxx: spec(SiCplusplus, "#00599C"),
	hpp: spec(SiCplusplus, "#00599C"),
	cs: spec(SiC, "#512BD4"),
	dart: spec(DiDart, "#0175C2"),
	lua: spec(SiLua, "#2C2D72"),

	// Shell / scripts
	sh: spec(SiGnubash, "#4EAA25"),
	bash: spec(SiGnubash, "#4EAA25"),
	zsh: spec(SiGnubash, "#4EAA25"),
	ps1: spec(DiTerminal, "#5391FE"),
	bat: spec(DiTerminal, "#5391FE"),
	cmd: spec(DiTerminal, "#5391FE"),

	// Data / config
	json: spec(SiJson, "#71717a"),
	jsonc: spec(SiJson, "#71717a"),
	json5: spec(SiJson, "#71717a"),
	yaml: spec(SiYaml, "#CB171E"),
	yml: spec(SiYaml, "#CB171E"),
	toml: spec(SiToml, "#9C4121"),
	xml: spec(SiSvg, "#E37933"),
	sql: spec(TbSql, "#00758F"),
	db: spec(SiSqlite, "#003B57"),
	sqlite: spec(SiSqlite, "#003B57"),
	env: spec(TbLock, "#EAB308"),
	lock: spec(TbLock, "#EAB308"),
	jwt: spec(SiJsonwebtokens, "#D63AFF"),

	// Databases / services
	redis: spec(SiRedis, "#DC382D"),
	mongo: spec(SiMongodb, "#47A248"),

	// Docs / text
	md: spec(SiMarkdown, "#71717a"),
	mdx: spec(SiMarkdown, "#71717a"),
	pdf: spec(TbFileTypePdf, "#EC2121"),

	// Media
	png: spec(TbPhoto, "#4F46E5"),
	jpg: spec(TbPhoto, "#4F46E5"),
	jpeg: spec(TbPhoto, "#4F46E5"),
	gif: spec(TbPhoto, "#4F46E5"),
	webp: spec(TbPhoto, "#4F46E5"),
	ico: spec(TbPhoto, "#4F46E5"),
	bmp: spec(TbPhoto, "#4F46E5"),
	mp3: spec(TbMusic, "#EC4899"),
	wav: spec(TbMusic, "#EC4899"),
	ogg: spec(TbMusic, "#EC4899"),
	flac: spec(TbMusic, "#EC4899"),
	mp4: spec(TbVideo, "#8B5CF6"),
	mov: spec(TbVideo, "#8B5CF6"),
	mkv: spec(TbVideo, "#8B5CF6"),
	webm: spec(TbVideo, "#8B5CF6"),

	// Archives
	zip: spec(TbFileZip, "#F59E0B"),
	tar: spec(TbFileZip, "#F59E0B"),
	gz: spec(TbFileZip, "#F59E0B"),
	rar: spec(TbFileZip, "#F59E0B"),
	"7z": spec(TbFileZip, "#F59E0B"),

	// Runtimes / tools
	node: spec(SiNodedotjs, "#5FA04E"),
	mysql: spec(SiMysql, "#4479A1"),
	pgsql: spec(SiPostgresql, "#4169E1"),
};

function fileIconSpec(name: string): FileIconSpec | null {
	const lower = name.toLowerCase();
	const byName = NAME_ICONS[lower];
	if (byName) return byName;
	for (const [prefix, entry] of NAME_PREFIX_ICONS) {
		if (lower.startsWith(prefix)) return entry;
	}
	const dot = lower.lastIndexOf(".");
	if (dot <= 0) return null;
	return EXT_ICONS[lower.slice(dot + 1)] ?? null;
}

/** Real file-type glyph for a basename; falls back to the generic FileIcon. */
export function FileTypeIcon({
	name,
	className,
}: {
	name: string;
	className?: string;
}) {
	const matched = fileIconSpec(name);
	const Icon = matched?.Icon ?? FileIcon;
	return (
		<Icon
			className={className}
			style={matched ? { color: matched.color } : undefined}
		/>
	);
}
