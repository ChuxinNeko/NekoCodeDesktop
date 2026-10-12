import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { compareFusionRuns, summarizeFusionRun, type FusionEvalPair } from "../src/main/fusion-eval";

interface Case {
	id: string;
	leadSession: string;
	fusionSession: string;
	leadPass?: boolean;
	fusionPass?: boolean;
}

const manifestPath = process.argv[2];
if (!manifestPath || process.argv.length !== 3) {
	console.error("Usage: bun scripts/fusion-eval.ts <manifest.json>");
	process.exit(2);
}
const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as { cases?: Case[] };
if (!Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error("Manifest needs a nonempty cases array");
const seen = new Set<string>();
const pairs: FusionEvalPair[] = manifest.cases.map((item) => {
	if (!item || typeof item.id !== "string" || !item.id.trim() || seen.has(item.id) ||
		typeof item.leadSession !== "string" || typeof item.fusionSession !== "string" ||
		(item.leadPass !== undefined && typeof item.leadPass !== "boolean") ||
		(item.fusionPass !== undefined && typeof item.fusionPass !== "boolean"))
		throw new Error("Invalid or duplicate evaluation case");
	seen.add(item.id);
	const lead = summarizeFusionRun(SessionManager.open(resolve(item.leadSession)).getBranch());
	const fusion = summarizeFusionRun(SessionManager.open(resolve(item.fusionSession)).getBranch());
	return { id: item.id, lead, fusion, leadPass: item.leadPass, fusionPass: item.fusionPass };
});
process.stdout.write(JSON.stringify({ summary: compareFusionRuns(pairs), cases: pairs }, null, 2) + "\n");
