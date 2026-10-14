const tools = new Set(["read", "grep", "find", "ls", "stat", "ast_grep", "semantic_search"]);

/** Tracks duplicate evidence requests; no fixed investigation cutoff or write authority. */
export class FusionInvestigationBudget {
 private attempts = 0;
 private turns = 0;
 private seen = new Set<string>();
 before(name: string, args: unknown): string | undefined {
  if (!tools.has(name)) return;
  this.attempts++;
  const key = JSON.stringify([name, args]);
  if (this.seen.has(key)) return "This exact investigation request was already attempted. Reuse its evidence; return missing facts to Lead instead of repeating it.";
  // Bound persisted tracking memory without limiting productive investigation.
  if (this.seen.size >= 128) this.seen.delete(this.seen.values().next().value!);
  this.seen.add(key);
 }
 finish(): void { this.turns++; }
 reset(): void { this.attempts = 0; this.turns = 0; this.seen.clear(); }
 snapshot() { return { attempts: this.attempts, turns: this.turns, seen: [...this.seen] }; }
 restore(value: unknown): boolean {
  const v = value as ReturnType<FusionInvestigationBudget["snapshot"]>;
  if (!v || ![v.attempts, v.turns].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) ||
   !Array.isArray(v.seen) || v.seen.length > 128 || !v.seen.every(s => typeof s === "string" && s.length <= 30000)) return false;
  this.attempts = v.attempts; this.turns = v.turns; this.seen = new Set(v.seen); return true;
 }
}
