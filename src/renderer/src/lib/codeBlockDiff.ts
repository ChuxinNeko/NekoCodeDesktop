import type { DiffRow } from "../components/CodeBlock";

/** Parse only hunk bodies: +++/--- inside a hunk can be actual source lines. */
export function codeBlockDiff(patch: string): DiffRow[] {
 const rows: DiffRow[] = [];
 let old = 0, cur = 0, inside = false;
 for (const line of patch.split("\n")) {
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk) { old = Number(hunk[1]); cur = Number(hunk[2]); inside = true; continue; }
  if (line.startsWith("diff ")) { inside = false; continue; }
  if (!inside) continue;
  if (line.startsWith("+")) rows.push({old:null,cur:cur++,type:"add",pieces:[{text:line.slice(1)}]});
  else if (line.startsWith("-")) rows.push({old:old++,cur:null,type:"del",pieces:[{text:line.slice(1)}]});
  else if (line.startsWith(" ")) rows.push({old:old++,cur:cur++,type:"ctx",pieces:[{text:line.slice(1)}]});
 }
 return rows;
}
