import type { Collection } from "mongodb";
import type { GitHubAuthorizationMethod } from "./contracts";

export interface GitHubAuthorizationDoc {
	_id: string;
	secretHash: string;
	method: GitHubAuthorizationMethod;
	status: "pending" | "exchanging" | "installing" | "ready" | "error";
	expiresAt: Date;
	nextPollAt: number;
	interval: number;
	/** AES-GCM ciphertext: PKCE verifier/device_code, or the completed grant. */
	payload: string;
	error?: string;
}

export interface GitHubSessionStore {
	create(doc: GitHubAuthorizationDoc): Promise<void>;
	get(id: string): Promise<GitHubAuthorizationDoc | null>;
	claim(id: string, now: number): Promise<boolean>;
	update(id: string, patch: Partial<GitHubAuthorizationDoc>): Promise<void>;
	take(id: string, secretHash: string, now: number): Promise<GitHubAuthorizationDoc | null>;
	remove(id: string): Promise<void>;
}

export class MongoGitHubSessionStore implements GitHubSessionStore {
	constructor(private readonly collection: Collection<GitHubAuthorizationDoc>) {}
	async create(doc: GitHubAuthorizationDoc) { await this.collection.insertOne(doc); }
	get(id: string) { return this.collection.findOne({ _id: id }); }
	async claim(id: string, now: number) {
		const result = await this.collection.updateOne(
			{ _id: id, status: { $in: ["pending", "installing"] }, expiresAt: { $gt: new Date(now) }, nextPollAt: { $lte: now } },
			{ $set: { status: "exchanging" } },
		);
		return result.modifiedCount === 1;
	}
	async update(id: string, patch: Partial<GitHubAuthorizationDoc>) {
		await this.collection.updateOne({ _id: id, status: "exchanging" }, { $set: patch });
	}
	take(id: string, secretHash: string, now: number) {
		return this.collection.findOneAndDelete({ _id: id, secretHash, status: "ready", expiresAt: { $gt: new Date(now) } });
	}
	async remove(id: string) { await this.collection.deleteOne({ _id: id }); }
}
