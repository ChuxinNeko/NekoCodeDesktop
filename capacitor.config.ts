import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "com.nekocode.mobile",
	appName: "NekoCode",
	webDir: "out/mobile",
	android: { path: "mobile/android" },
	ios: { path: "mobile/ios", contentInset: "never" },
};
export default config;
