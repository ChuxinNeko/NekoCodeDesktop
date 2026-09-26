import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions, ProviderStreams, TranscriptContext } from "@earendil-works/pi-ai";
import type { AntigravityOAuthService } from "./antigravity-oauth-service";
import { antigravityModels } from "./antigravity-request";
import { AntigravityStream } from "./antigravity-stream";
import { piAi } from "./pi";

/** Tokens stay in safeStorage; PI sees an ambient OAuth availability check. */
export async function registerAntigravityProvider(runtime: ModelRuntime, oauth: AntigravityOAuthService): Promise<void> {
	const ai = await piAi();
	const executor = new AntigravityStream(oauth);
	const stream = (model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions) => {
		// PI hands providers a transcript whose system messages carry the prompt
		// and the tool set. Antigravity has no mid-conversation system messages,
		// so it takes their replayed state as one instruction and one tool list.
		const { messages } = transcript;
		const context: Context = {
			systemPrompt: ai.getCurrentSystemPrompt(messages) || undefined,
			tools: ai.getCurrentTools(messages),
			messages: messages.filter((message) => message.role !== "system"),
		};
		const output = ai.createAssistantMessageEventStream();
		void executor.run(output, model, context, options);
		return output;
	};
	runtime.registerNativeProvider(ai.createProvider({
		id: "antigravity", name: "Antigravity (Google)", models: antigravityModels(),
		auth: { apiKey: {
			name: "Antigravity OAuth",
			check: async () => oauth.list().signedIn ? { type: "oauth", source: "Antigravity OAuth" } : undefined,
			resolve: async () => oauth.list().signedIn ? { auth: {}, source: "Antigravity OAuth" } : undefined,
		} },
		filterModels: (models) => oauth.list().signedIn ? models : [],
		api: { stream, streamSimple: stream } satisfies ProviderStreams,
	}));
	await runtime.refresh({ allowNetwork: false, providers: ["antigravity"] });
}
