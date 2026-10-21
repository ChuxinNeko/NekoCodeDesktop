/**
 * Refresh the CC Switch catalog and provider marks from a local checkout.
 * Usage: bun scripts/sync-cc-switch-presets.ts ../cc-switch
 * The original MIT notice is retained in licenses/cc-switch-LICENSE.txt.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const referenceRoot = resolve(process.argv[2] ?? "../cc-switch");
const load = (path: string) => import(pathToFileURL(join(referenceRoot, path)).href);
const [{ providerPresets }, { codexProviderPresets }, { PRESET_FAMILIES }, { PRESET_SEARCH_ALIASES }] = await Promise.all([
	load("src/config/claudeProviderPresets.ts"), load("src/config/codexProviderPresets.ts"), load("src/config/presetFamilies.ts"), load("src/config/presetSearchAliases.ts"),
]);
const convert = (preset: any, index: number, agent: string) => ({
	id: `cc-switch-${agent}-${index}`, name: preset.name, category: preset.category ?? "third_party",
	websiteUrl: preset.websiteUrl, apiKeyUrl: preset.apiKeyUrl, family: preset.family,
	familyName: preset.family ? PRESET_FAMILIES[preset.family]?.name : undefined,
	planKey: preset.planKey, regionKey: preset.regionKey, icon: preset.icon, iconColor: preset.iconColor,
	aliases: PRESET_SEARCH_ALIASES[preset.icon] ?? PRESET_SEARCH_ALIASES[preset.name] ?? "",
	apiFormat: preset.apiFormat, requiresOAuth: preset.requiresOAuth || (!!preset.providerType && preset.category !== "official"),
	config: agent === "codex" ? preset.config : JSON.stringify(preset.settingsConfig ?? { env: {} }, null, 2),
	apiKey: agent === "codex" ? (preset.auth?.OPENAI_API_KEY ?? "") : (preset.settingsConfig?.env?.[preset.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"] ?? ""),
	apiKeyField: preset.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN", modelCatalog: preset.modelCatalog, endpointCandidates: preset.endpointCandidates,
});
const snapshots = {
	claude: providerPresets.flatMap((preset: any, index: number) => preset.hidden ? [] : [convert(preset, index, "claude")]),
	codex: codexProviderPresets.flatMap((preset: any, index: number) => preset.hidden ? [] : [convert(preset, index, "codex")]),
};
writeFileSync(join(repoRoot, "src/shared/acp-provider-presets.json"), `${JSON.stringify(snapshots, null, 2)}\n`);
copyFileSync(join(referenceRoot, "LICENSE"), join(repoRoot, "licenses/cc-switch-LICENSE.txt"));

const buildDir = mkdtempSync(join(tmpdir(), "nekocode-cc-icons-"));
try {
	const result = await Bun.build({
		entrypoints: [join(referenceRoot, "src/icons/extracted/index.ts")], target: "browser", outdir: buildDir, naming: "icons.mjs",
		plugins: [{ name: "vite-url-imports", setup(build) {
			build.onLoad({ filter: /\.(svg|png|jpg)$/ }, ({ path }) => ({ contents: `export default ${JSON.stringify(path)}`, loader: "js" }));
			build.onResolve({ filter: /\.(svg|png|jpg)\?url$/ }, ({ path, importer }) => ({ path: resolve(dirname(importer), path.split("?")[0]) }));
		} }],
	});
	if (!result.success) throw new Error(result.logs.map(String).join("\n"));
	const source = await import(pathToFileURL(join(buildDir, "icons.mjs")).href);
	const names = new Set<string>(Object.values(snapshots).flat().map((preset: any) => preset.icon).filter(Boolean));
	const icons: Record<string, { svg?: string; src?: string; tile?: boolean }> = {};
	const assetsDir = join(repoRoot, "src/renderer/src/assets/cc-switch-providers");
	mkdirSync(assetsDir, { recursive: true });
	for (const name of names) {
		const svg = source.getIcon(name), original = source.getIconUrl(name);
		let src: string | undefined;
		if (original) {
			src = `${name.replace(/[^a-z0-9-]/gi, "-")}${extname(original)}`;
			copyFileSync(original, join(assetsDir, src));
		}
		if (svg || src) icons[name] = { svg: svg || undefined, src, tile: source.isTileIcon(name) };
	}
	writeFileSync(join(repoRoot, "src/renderer/src/lib/acp-provider-icons.json"), `${JSON.stringify(icons)}\n`);
	console.log(`Imported ${snapshots.claude.length} Claude presets, ${snapshots.codex.length} Codex presets, and ${Object.keys(icons).length} provider marks.`);
} finally { rmSync(buildDir, { recursive: true, force: true }); }
