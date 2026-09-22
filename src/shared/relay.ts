export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_MAX_PLAINTEXT_BYTES = 1024 * 1024;

export type RelayDirection = "mobile-to-desktop" | "desktop-to-mobile";

export interface RelayIdentity {
	version: 1;
	id: string;
	publicKey: string;
	privateKey: string;
}

export interface RelayCiphertext {
	version: 1;
	iv: string;
	data: string;
}

export interface RelayRequest {
	id: string;
	method: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
}

export interface RelayResponse {
	id: string;
	status: number;
	body: unknown;
}

export interface RelayLoginRequest {
	email: string;
	password: string;
}

export interface RelayRegisterRequest {
	email: string;
	password: string;
}

export interface RelayVerifyRequest {
	email: string;
	code: string;
}

export interface RelayResendRequest {
	email: string;
}

export interface RelayDeviceSummary {
	id: string;
	name: string;
	publicKey: string;
	lastSeenAt: string;
	online: boolean;
}

export interface RelayStatus {
	state: "signed-out" | "connecting" | "ready" | "error";
	account: { email: string } | null;
	device: { id: string; name: string } | null;
	error?: string;
}
