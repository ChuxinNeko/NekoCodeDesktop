/**
 * Code intelligence: the code index behind `semantic_search`, and Tab
 * completion in the IDE layout.
 *
 * Neither has a service of its own to configure: both use a chat model from
 * Settings → Providers and models, picked by its `provider/model` key. The
 * index ranks by keywords on its own; with a model it also has the question
 * rewritten into code terms and the candidates reranked by relevance.
 */

/**
 * Names embedding and reranking models go by. They are listed by some
 * providers next to chat models but cannot hold a conversation, so they are
 * kept out of the pickers.
 */
export function looksLikeEmbeddingModel(modelId: string): boolean {
	return /embed|(?:^|[/_-])(?:bge|e5|gte|m3e)(?:[/_.-]|$)|nomic-embed|rerank/i.test(modelId);
}

export interface CodeIntelModelOption {
	/** `provider/model`. */
	key: string;
	/** `Provider name / model`. */
	label: string;
	/** A provider added with its own API address and key, or an account signed in to. */
	group: "custom" | "account";
}

export interface CodeIntelModels {
	/** Every chat model, custom API providers first, for search assistance and Tab completion alike. */
	chat: CodeIntelModelOption[];
}

export interface CodeIntelStatus {
	prediction: { enabled: boolean; modelKey: string | null };
	/** Whether sessions get `semantic_search`. */
	indexEnabled: boolean;
	/** The model that rewrites queries and reranks results; null keeps search keyword-only. */
	searchModel: string | null;
	completion: {
		enabled: boolean;
		/** The model suggestions come from; null until one is picked. */
		modelKey: string | null;
	};
}

export interface CodeIntelUpdate {
	prediction?: Partial<CodeIntelStatus["prediction"]>;
	indexEnabled?: boolean;
	searchModel?: string | null;
	completion?: Partial<CodeIntelStatus["completion"]>;
}

// --- Index status ---------------------------------------------------------------

export type IndexState = "idle" | "scanning" | "ready" | "error";

export interface IndexStatus {
	cwd: string;
	state: IndexState;
	files: number;
	chunks: number;
	error: string | null;
	updatedAt: number | null;
}

// --- Completion request ---------------------------------------------------------

export interface CompletionRequest {
	/** Chosen by the renderer, so a superseded request can be cancelled by id. */
	id: string;
	cwd: string;
	relPath: string;
	languageId: string;
	/** Text before the cursor, already clipped by the renderer. */
	prefix: string;
	/** Text after the cursor, already clipped. */
	suffix: string;
}

export interface CompletionResponse {
	/** What to insert at the cursor; empty for nothing worth showing. */
	text: string;
}

export interface PromptPredictionRequest {
	id: string;
	userText: string;
	answerText: string;
	language: "zh-CN" | "en";
}
