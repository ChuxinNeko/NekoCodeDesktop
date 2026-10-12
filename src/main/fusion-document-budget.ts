/** A bounded assembly phase, not a deadline or a claim of token savings. */
export const FUSION_DOCUMENT_RETURN = "nekocode.fusion.document-return.v1";
export const DOCUMENT_INVESTIGATION_LIMIT = 12;
export const DOCUMENT_LOCATION_LIMIT = 2;
export const DOCUMENT_REVIEW_LIMIT = 4;

/** Recognize a code-audit-to-document task, not arbitrary tasks which mention a .md file. */
export function isDocumentReviewTask(text: string): boolean {
	const normalized = text.replace(/\\(?=\.)/g, "");
	const positive = normalized.replace(/(?:不|不要|禁止)(?:修改|编辑|修复)[^，。;\n]*/g, "");
	const codeChange = /(?:修复|修改|编辑|实现)[^，。;\n]{0,16}(?:源码|代码|src[\\/])|\b(?:fix|modify|edit|implement)\s+(?:the\s+)?(?:bug|code|source|src[\\/])|(?:write|create|generate|写入|创建|生成)[^，。;\n]{0,40}\.(?:tsx?|jsx?|py|rs)\b/i.test(positive);
	return !codeChange && /审查|审计|review|audit/i.test(normalized) &&
		/写入|写到|保存|撰写|生成|创建|产出|write|save|generate|create|produce/i.test(normalized) &&
		/代码|源码|项目|Fusion|NekoCode|code|source|\.(ts|tsx|js|py|rs)\b/i.test(normalized) &&
		/[\p{L}\p{N}_./\\-]+\.(md|txt|rst|adoc)\b/iu.test(normalized);
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10000;

/** Covers Lead's whole user task; handoffs and resume must not refresh discovery budgets. */
export class FusionDocumentReviewBudget {
	private active = false;
	private attempts = 0;
	private searches = 0;
	private reviewing = false;
	private reviewReads = 0;
	private discoveryLimit = DOCUMENT_INVESTIGATION_LIMIT;
	private searchLimit = DOCUMENT_LOCATION_LIMIT;
	private reviewLimit = DOCUMENT_REVIEW_LIMIT;
	private extended = false;
	private onlyPath?: string;
	start(text: string): void {
		this.reset(); this.active = isDocumentReviewTask(text);
		if (this.active && /只允许|仅允许|\bonly\b/i.test(text)) {
			this.onlyPath = text.replace(/\\(?=\.)/g, "").match(/(?:写入|写到|保存(?:到)?|撰写|生成|创建|产出|write|save|generate|create|produce)\s*(?:(?:only|a|the|report|document|to)\s+)*[`'"\s]*([\p{L}\p{N}_./\\-]+\.(?:md|txt|rst|adoc))\b/iu)?.[1];
		}
		const sections = text.match(/^\s*\d+[.、)]\s*/gm)?.length ?? 0;
		this.discoveryLimit = Math.max(12, Math.min(24, sections * 2 + 4));
		this.searchLimit = Math.max(2, Math.min(4, Math.ceil(sections / 3)));
		this.reviewLimit = Math.max(4, Math.min(10, Math.ceil(sections / 2) + 2));
	}
	reset(): void {
		this.active = false; this.attempts = 0; this.searches = 0; this.reviewing = false; this.reviewReads = 0;
		this.discoveryLimit = 12; this.searchLimit = 2; this.reviewLimit = 4; this.extended = false;
		this.onlyPath = undefined;
	}
	get document(): boolean { return this.active; }
	get explicitDocumentPath(): string | undefined { return this.onlyPath; }
	get canSearch(): boolean { return !this.active || (!this.reviewing && this.searches < this.searchLimit && this.attempts < this.discoveryLimit); }
	get canRead(): boolean { return !this.active || (this.reviewing ? this.reviewReads < this.reviewLimit : this.attempts < this.discoveryLimit); }
	handoff(): void { if (this.active) this.reviewing = true; }
	/** One bounded supplement for a concrete unresolved report, not an unlimited resume reset. */
	supplement(): void {
		if (!this.active || this.extended) return;
		this.extended = true; this.reviewing = false;
		this.discoveryLimit = this.attempts + 4; this.searchLimit = this.searches + 1;
	}
	snapshot() { return { active: this.active, attempts: this.attempts, searches: this.searches, reviewing: this.reviewing,
		reviewReads: this.reviewReads, discoveryLimit: this.discoveryLimit, searchLimit: this.searchLimit, reviewLimit: this.reviewLimit, extended: this.extended, onlyPath: this.onlyPath }; }
	restore(value: unknown): boolean {
		const v = value as ReturnType<FusionDocumentReviewBudget["snapshot"]>;
		if (!v || typeof v.active !== "boolean" || typeof v.reviewing !== "boolean" || typeof v.extended !== "boolean" ||
			![v.attempts, v.searches, v.reviewReads, v.discoveryLimit, v.searchLimit, v.reviewLimit].every(count) ||
			v.discoveryLimit > 28 || v.searchLimit > 5 || v.reviewLimit > 10 ||
			(v.onlyPath !== undefined && (typeof v.onlyPath !== "string" || !v.onlyPath || v.onlyPath.length > 1000))) return false;
		this.active = v.active; this.attempts = v.attempts; this.searches = v.searches; this.reviewing = v.reviewing;
		this.reviewReads = v.reviewReads; this.discoveryLimit = v.discoveryLimit; this.searchLimit = v.searchLimit;
		this.reviewLimit = v.reviewLimit; this.extended = v.extended; this.onlyPath = v.onlyPath; return true;
	}
	get policy(): string { return `Lead discovery: ${this.discoveryLimit} read/code_search attempts, at most ${this.searchLimit} searches. Acceptance: ${this.reviewLimit} reads. One bounded supplement may follow a concrete unresolved report.`; }
	before(name: string): string | undefined {
		if (!this.active) return;
		if (name === "task") return "Document review uses the shared inline fusion_implement handoff; do not create another investigation session.";
		if (!["read", "code_search"].includes(name)) return;
		if (name === "code_search" && !this.canSearch)
			return `Document location budget exhausted (maximum ${this.searchLimit} code_search calls per user task). Reuse existing locations; hand conclusions and evidence to Sidekick through fusion_implement. Mark missing API evidence unverified.`;
		if (name === "read" && !this.canRead)
			return this.reviewing ? `Document acceptance budget exhausted (${this.reviewLimit} reads across all handoffs). Decide from observed evidence; missing checks remain unverified. Do not restart the audit.` :
				`Document discovery budget exhausted (${this.discoveryLimit} read/code_search attempts). Stop discovery and call fusion_implement with the conclusions, outline and evidence locations already collected.`;
		if (this.reviewing) this.reviewReads++;
		else { this.attempts++; if (name === "code_search") this.searches++; }
	}
}

export function isDocumentScope(paths: readonly string[]): boolean {
	return paths.length > 0 && paths.every((path) => /\.(md|txt|rst|adoc)$/i.test(path));
}

export class FusionDocumentBudget {
	private attempts = 0;
	private sinceProgress = 0;
	private active = false;
	start(paths: readonly string[]): void { this.active = isDocumentScope(paths); }
	reset(): void { this.active = false; this.attempts = 0; this.sinceProgress = 0; }
	get document(): boolean { return this.active; }
	get exhausted(): boolean { return this.active && (this.sinceProgress >= DOCUMENT_INVESTIGATION_LIMIT || this.attempts >= 36); }
	snapshot() { return { active: this.active, attempts: this.attempts, sinceProgress: this.sinceProgress }; }
	restore(value: unknown): boolean {
		const v = value as ReturnType<FusionDocumentBudget["snapshot"]>;
		if (!v || typeof v.active !== "boolean" || !count(v.attempts) || !count(v.sinceProgress)) return false;
		this.active = v.active; this.attempts = v.attempts; this.sinceProgress = v.sinceProgress; return true;
	}
	/** Count attempts, including denied searches, so tool errors cannot cause an endless retry loop. */
	before(name: string): string | undefined {
		if (!this.active || ["write", "edit", "ast_edit", "fusion_review"].includes(name)) return;
		if (this.exhausted) return "Document investigation budget exhausted. Return missing evidence through fusion_review; do not repeat searches.";
		this.attempts++; this.sinceProgress++;
	}
	observe(name: string, isError: boolean, changed = false): void {
		if (!this.active) return;
		if (["write", "edit", "ast_edit"].includes(name)) {
			// Only an actual successful edit counts as progress, never a promise or a failed write.
			if (isError) { this.attempts++; this.sinceProgress++; }
			else if (changed) this.sinceProgress = 0;
		}
	}
}
