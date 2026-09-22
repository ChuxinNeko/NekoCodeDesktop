import { Preferences } from "@capacitor/preferences";
import type { RelayIdentity } from "../../src/shared/relay";
import { generateRelayIdentity, validateRelayIdentity } from "../../src/shared/relay-crypto";

export interface PreferencesLike {
	get(options: { key: string }): Promise<{ value: string | null }>;
	set(options: { key: string; value: string }): Promise<void>;
	remove(options: { key: string }): Promise<void>;
}

const IDENTITY_KEY = "relay-identity";

export class MobileRelayIdentityStore {
	constructor(private readonly preferences: PreferencesLike = Preferences) {}

	async load(): Promise<RelayIdentity> {
		let saved: unknown = null;
		try {
			const raw = (await this.preferences.get({ key: IDENTITY_KEY })).value;
			saved = raw ? JSON.parse(raw) : null;
		} catch {
			saved = null;
		}
		const identity = await validateRelayIdentity(saved);
		if (identity) return identity;
		const generated = await generateRelayIdentity();
		await this.preferences.set({ key: IDENTITY_KEY, value: JSON.stringify(generated) });
		return generated;
	}
}
