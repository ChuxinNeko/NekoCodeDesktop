export interface LanPairingPayload {
	type: "nekocode.lan-pairing";
	version: 1;
	endpoint: string;
	code: string;
	expiresAt: number;
}

/** Only literal local addresses are allowed as destinations for pairing credentials. */
export function normalizeDesktopAddress(value: string): string {
	const url = new URL(value.includes("://") ? value : `http://${value}`);
	const parts = url.hostname.split(".").map(Number);
	const local = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
		(parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
		(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254) ||
		(parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127));
	if (url.protocol !== "http:" || (!local && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new Error("请输入电脑显示的局域网地址，例如 http://192.168.1.8:47832");
	}
	if (!url.port) url.port = "47832";
	return url.origin;
}

export function encodeLanPairing(endpoint: string, pairing: { code: string; expiresAt: number }): string {
	return JSON.stringify({ type: "nekocode.lan-pairing", version: 1, endpoint: normalizeDesktopAddress(endpoint), code: pairing.code, expiresAt: pairing.expiresAt } satisfies LanPairingPayload);
}

/** A scanned QR is data, never a URL to open or a command to execute. */
export function parseLanPairing(text: string, now = Date.now()): LanPairingPayload {
	if (text.length > 2048) throw new Error("请扫描 NekoCode 电脑端的配对二维码");
	let value: Partial<LanPairingPayload>;
	try { value = JSON.parse(text); }
	catch { throw new Error("请扫描 NekoCode 电脑端的配对二维码"); }
	if (!value || value.type !== "nekocode.lan-pairing" || value.version !== 1 ||
		typeof value.endpoint !== "string" || typeof value.code !== "string" || !/^[A-F0-9]{10}$/.test(value.code) ||
		typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) {
		throw new Error("配对二维码格式不正确，请在电脑端重新生成");
	}
	if (value.expiresAt <= now) throw new Error("配对二维码已过期，请在电脑端重新生成");
	return { type: "nekocode.lan-pairing", version: 1, endpoint: normalizeDesktopAddress(value.endpoint), code: value.code, expiresAt: value.expiresAt };
}
