/**
 * The user-property seed injected into a Wallpaper Engine web wallpaper.
 * Values come from `project.json` `general.properties`, in the same shape the
 * wallpaper's `wallpaperPropertyListener` expects. Hidden editor flags are
 * dropped; everything else is sent, including properties a condition would hide.
 */

const KNOWN_TYPES = new Set(["color", "bool", "slider", "combo", "text", "textinput", "file", "directory", "group", "other"]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orderOf(def: JsonRecord): number {
	const order = Number(def.order);
	return Number.isFinite(order) ? order : 0;
}

function wireValue(ptype: string, def: JsonRecord): unknown {
	if (!("value" in def)) return undefined;
	const raw = def.value;
	if (raw === null || raw === undefined) return undefined;
	switch (ptype) {
		case "color":
			return typeof raw === "string" ? raw : undefined;
		case "bool":
			return typeof raw === "boolean" ? raw : undefined;
		case "slider": {
			const number = typeof raw === "number" ? raw : Number(raw);
			return Number.isFinite(number) ? number : undefined;
		}
		case "combo":
			return raw;
		default:
			return typeof raw === "string" ? raw : JSON.stringify(raw);
	}
}

function rawProps(project: JsonRecord): Array<[string, JsonRecord]> {
	const general = isRecord(project.general) ? project.general : null;
	const props = general && isRecord(general.properties) ? general.properties : null;
	if (!props) return [];
	const entries = Object.entries(props).filter((entry): entry is [string, JsonRecord] => isRecord(entry[1]) && typeof entry[1].type === "string");
	entries.sort((a, b) => orderOf(a[1]) - orderOf(b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return entries;
}

export interface UserPropDef {
	name: string;
	value: unknown;
}

export function entryDirPrefix(entryRel: string): string {
	const rel = entryRel.trim().replace(/\\/g, "/");
	if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) return "";
	const slash = rel.lastIndexOf("/");
	return slash < 0 ? "" : rel.slice(0, slash + 1);
}

export function parseUserPropDefs(project: unknown, filePrefix = ""): UserPropDef[] {
	if (!isRecord(project)) return [];
	const out: UserPropDef[] = [];
	for (const [name, def] of rawProps(project)) {
		if (def.editable === false) continue;
		const declared = String(def.type || "other");
		const kind = KNOWN_TYPES.has(declared) ? declared : "other";
		let value = wireValue(kind, def);
		if (kind === "file" && typeof value === "string" && value !== "" && filePrefix) value = `${filePrefix}${value}`;
		if (value === undefined) continue;
		out.push({ name, value });
	}
	return out;
}

/** `window.__weSeedProps({...})` or an empty string when the project declares nothing. */
export function buildSeedScript(project: unknown, entryRel: string): string {
	const defs = parseUserPropDefs(project, entryDirPrefix(entryRel));
	if (defs.length === 0) return "";
	const wire: Record<string, { value: unknown }> = {};
	for (const def of defs) wire[def.name] = { value: def.value };
	return `window.__weSeedProps(${JSON.stringify(wire)});`;
}
