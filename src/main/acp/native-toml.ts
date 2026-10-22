import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { isRecord } from "../../shared/acp-providers";

/** Preserve unrelated statements, comments, table order and multiline values. */
export function patchProviderToml(source: string, before: Record<string, unknown>, after: Record<string, unknown>): string {
	before = structuredClone(before);
	after = structuredClone(after);
	const rootKeys = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => key !== "model_providers" && !isDeepStrictEqual(before[key], after[key])));
	const oldProviders = isRecord(before.model_providers) ? before.model_providers : {};
	const newProviders = isRecord(after.model_providers) ? after.model_providers : {};
	const providerKeys = new Set([...Object.keys(oldProviders), ...Object.keys(newProviders)].filter((key) => !isDeepStrictEqual(oldProviders[key], newProviders[key])));
	const kept: string[] = [];
	let firstHeader = -1;
	let context: string[] = [];
	let pending = "";
	const eol = source.includes("\r\n") ? "\r\n" : "\n";
	for (const line of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
		if (!line) continue;
		if (!pending && /^\s*(?:#.*)?(?:\r?\n)?$/.test(line)) { kept.push(line); continue; }
		pending += line;
		let parsed: Record<string, unknown>;
		try { parsed = parse(pending); } catch { continue; } // A multiline value is not complete yet.
		const header = pending.trimStart().startsWith("[");
		if (header) {
			if (firstHeader < 0) firstHeader = kept.length;
			context = [];
			let part: unknown = parsed;
			while (isRecord(part) && Object.keys(part).length === 1) {
				const key = Object.keys(part)[0];
				context.push(key);
				part = part[key];
			}
		}
		const skipProviderTable = context[0] === "model_providers" && context.length >= 2 && providerKeys.has(context[1]);
		const skipRoot = !context.length && Object.keys(parsed).some((key) => rootKeys.has(key));
		const skipInlineProvider = context.length === 1 && context[0] === "model_providers" && !header && Object.keys(parsed).some((key) => providerKeys.has(key));
		// Unusual dotted/inline root routing can span several tables. Preserve its
		// values via the parser rather than risking a duplicate TOML declaration.
		if (!header && !context.length && "model_providers" in parsed && providerKeys.size) return stringify(after as Parameters<typeof stringify>[0]);
		if (!skipProviderTable && !skipRoot && !skipInlineProvider) kept.push(pending);
		pending = "";
	}
	if (pending.trim()) throw new Error("无法完整解析 Codex 配置，原文件未修改");
	const additions = Object.fromEntries([...rootKeys].filter((key) => key in after).map((key) => [key, after[key]]));
	const rootText = Object.keys(additions).length ? stringify(additions as Parameters<typeof stringify>[0]).replace(/\r?\n/g, eol) : "";
	const index = firstHeader < 0 ? kept.length : firstHeader;
	const prefix = kept.slice(0, index).join("");
	let result = prefix + (prefix && !prefix.endsWith("\n") && rootText ? eol : "") + rootText + kept.slice(index).join("");
	const routes = Object.fromEntries([...providerKeys].filter((key) => key in newProviders).map((key) => [key, newProviders[key]]));
	if (Object.keys(routes).length) result += `${result && !result.endsWith("\n") ? eol : ""}${eol}${stringify({ model_providers: routes } as Parameters<typeof stringify>[0]).replace(/\r?\n/g, eol)}`;
	const verified = structuredClone(parse(result));
	if (!("model_providers" in after) && isRecord(verified.model_providers) && !Object.keys(verified.model_providers).length) delete verified.model_providers;
	if (!isDeepStrictEqual(verified, after)) throw new Error("Codex 配置校验失败，原文件未修改");
	return result;
}
