import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions, ProviderStreams } from "@earendil-works/pi-ai";
import type { AntigravityOAuthService } from "./antigravity-oauth-service";
import { antigravityModels } from "./antigravity-request";
import { AntigravityStream } from "./antigravity-stream";
import { piAi } from "./pi";

/** Tokens stay in safeStorage; PI sees an ambient OAuth availability check. */
export async function registerAntigravityProvider(runtime: ModelRuntime, oauth: AntigravityOAuthService): Promise<void> {
	const ai = await piAi();
	const executor = new AntigravityStream(oauth);
	const stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
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
		api: { stream, streamSimple: stream } as ProviderStreams,
	}));
	await runtime.refresh({ allowNetwork: false, providers: ["antigravity"] });
}
