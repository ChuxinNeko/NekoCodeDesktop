export type ModelApiProtocol =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages";

export interface ModelProfileSummary {
	id: string;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	modelIds: string[];
	hasApiKey: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ModelStoreStatus {
	encryptionAvailable: boolean;
	backend: string;
	warning?: string;
}

export interface SaveModelProfileRequest {
	id?: string;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	apiKey?: string;
	modelIds: string[];
}

export interface FetchModelsRequest {
	profileId?: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	apiKey?: string;
}

export interface FetchedModel {
	id: string;
	name: string;
}

export interface ModelTestRequest {
	profileId: string;
	modelId: string;
}

export interface ModelTestResult {
	ok: boolean;
	latencyMs: number;
	message: string;
	output?: string;
}
