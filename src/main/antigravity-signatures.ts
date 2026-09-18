/** Local envelope checks from CLIProxyAPI/internal/signature. Ciphertext stays opaque. */
export const GEMINI_SIGNATURE_BYPASS = "skip_thought_signature_validator";
type Field = { number: number; wire: number; bytes?: Buffer };
function fields(bytes: Buffer): Field[] {
	let offset = 0;
	const varint = () => {
		let value = 0n;
		for (let shift = 0; shift < 70; shift += 7) {
			if (offset >= bytes.length) throw new Error("truncated protobuf");
			const b = bytes[offset++]!; value |= BigInt(b & 127) << BigInt(shift);
			if (!(b & 128)) return value;
		}
		throw new Error("invalid protobuf");
	};
	const result: Field[] = [];
	while (offset < bytes.length) {
		const tag = Number(varint());
		const field: Field = { number: tag >>> 3, wire: tag & 7 };
		if (!field.number) throw new Error("invalid protobuf field");
		if (field.wire === 0) varint();
		else if (field.wire === 1) offset += 8;
		else if (field.wire === 5) offset += 4;
		else if (field.wire === 2) {
			const length = Number(varint());
			if (!Number.isSafeInteger(length)) throw new Error("invalid protobuf length");
			field.bytes = bytes.subarray(offset, offset + length); offset += length;
		} else throw new Error("unsupported protobuf wire type");
		if (offset > bytes.length) throw new Error("truncated protobuf");
		result.push(field);
	}
	return result;
}
function decode(value: string): Buffer {
	if (!value || value.length > 1_048_576 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.replace(/=+$/, "").length % 4 === 1) throw new Error("invalid signature");
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "") || (value.includes("=") && value.length % 4 !== 0)) throw new Error("invalid signature encoding");
	return decoded;
}
function unwrap(bytes: Buffer, number: number, single = false): Buffer {
	const parsed = fields(bytes);
	const values = parsed.filter((field) => field.number === number);
	if (!values.length || values.some((field) => field.wire !== 2) || (single && parsed.length !== 1)) throw new Error("invalid signature envelope");
	return values.at(-1)!.bytes!;
}
export function claudeSignature(raw: unknown): string | undefined {
	if (typeof raw !== "string") return;
	try {
		const value = raw.trim().replace(/^claude#/, "");
		const inner = value.startsWith("R") ? decode(value).toString("utf8") : value;
		if (!inner.startsWith("E") || value.length % 4 !== 0 || inner.length % 4 !== 0) return;
		const bytes = decode(inner);
		if (bytes[0] !== 0x12) return;
		const channel = fields(unwrap(unwrap(bytes, 2), 1));
		if (!channel.some((f) => f.number === 1 && f.wire === 0)) return;
		for (const field of channel) {
			if ([1, 2, 7].includes(field.number) && field.wire !== 0) return;
			if (field.number === 6) {
				if (field.wire !== 2) return;
				new TextDecoder("utf8", { fatal: true }).decode(field.bytes);
			}
		}
		return value.startsWith("R") ? value : Buffer.from(inner).toString("base64");
	} catch { return; }
}
export function geminiSignature(raw: unknown): string | undefined {
	if (typeof raw !== "string") return;
	try {
		const value = raw.trim().replace(/^gemini#/, "");
		if (claudeSignature(value)) return;
		const payload = unwrap(unwrap(decode(value), 2, true), 1, true);
		if (payload[0] === 1) return value;
		if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(payload.toString())) return value;
		if (fields(payload).some((f) => f.wire === 2 && f.bytes?.[0] === 1)) return value;
	} catch { return; }
}
