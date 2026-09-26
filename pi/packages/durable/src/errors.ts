/** A transaction read a table after its first table write. Read every required row before writing. */
export class ReadAfterWrite extends Error {
	constructor(method: string) {
		super(`Tx.${method}() cannot read tables after the first table write`);
		this.name = "ReadAfterWrite";
	}
}

/** Storage rejected a batch before any durable effect; the owning Session may continue safely. */
export class StorageRejected extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StorageRejected";
	}
}
