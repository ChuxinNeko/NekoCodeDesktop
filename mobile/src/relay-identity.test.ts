import { expect, test } from "bun:test";
import { MobileRelayIdentityStore, type PreferencesLike } from "./relay-identity";
import { validateRelayIdentity } from "../../src/shared/relay-crypto";

function fakePreferences(): PreferencesLike & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		get: async ({ key }) => ({ value: data.get(key) ?? null }),
		set: async ({ key, value }) => { data.set(key, value); },
		remove: async ({ key }) => { data.delete(key); },
	};
}

test("identity is generated once and stays stable across store instances", async () => {
	const preferences = fakePreferences();
	const first = await new MobileRelayIdentityStore(preferences).load();
	expect(await validateRelayIdentity(first)).not.toBeNull();
	const again = await new MobileRelayIdentityStore(preferences).load();
	expect(again).toEqual(first);
	expect(JSON.parse(preferences.data.get("relay-identity")!)).toEqual(first);
});

test("a corrupt or invalid record is replaced, not returned", async () => {
	const preferences = fakePreferences();
	preferences.data.set("relay-identity", "not json{");
	const generated = await new MobileRelayIdentityStore(preferences).load();
	expect(await validateRelayIdentity(generated)).not.toBeNull();

	const other = await new MobileRelayIdentityStore(fakePreferences()).load();
	preferences.data.set("relay-identity", JSON.stringify({ ...other, privateKey: generated.privateKey }));
	const rebuilt = await new MobileRelayIdentityStore(preferences).load();
	expect(await validateRelayIdentity(rebuilt)).not.toBeNull();
	expect(rebuilt.privateKey).not.toBe(generated.privateKey);
});
