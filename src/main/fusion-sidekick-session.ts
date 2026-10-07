/** A conversation-scoped worker session; authority belongs to its current task, not its history. */
export interface SidekickSessionResource {
	abort(): Promise<void>;
	dispose(): void;
	setActiveToolsByName(names: string[]): void;
}

export class FusionSidekickSession<T extends SidekickSessionResource, L> {
	private resource?: T;
	private key?: string;
	private generation = 0;
	private lease?: L;
	private retiring = new Set<Promise<void>>();

	get current(): L | undefined { return this.lease; }
	get session(): T | undefined { return this.resource; }

	async acquire(key: string, lease: L, create: () => Promise<T>): Promise<T> {
		if (this.lease) throw new Error("Sidekick session is already leased to a task");
		if (this.key !== key) this.reset();
		const generation = this.generation;
		await this.whenSettled();
		if (generation !== this.generation) throw new Error("Sidekick acquisition was invalidated");
		if (this.lease) throw new Error("Sidekick session is already leased to a task");
		this.lease = lease;
		this.key = key;
		try {
			if (!this.resource) {
				const resource = await create();
				if (generation !== this.generation || this.lease !== lease) {
					this.retire(resource);
					throw new Error("Sidekick setup was invalidated");
				}
				this.resource = resource;
			}
			return this.resource;
		} catch (error) {
			if (this.lease === lease) this.reset();
			throw error;
		}
	}

	release(lease: L, healthy: boolean): void {
		if (this.lease !== lease) return;
		if (!healthy) { this.reset(); return; }
		this.lease = undefined;
		// No project tools may run between tasks, even if the old transcript asks for them.
		this.resource?.setActiveToolsByName([]);
	}

	reset(): void {
		this.generation++;
		this.lease = undefined;
		this.key = undefined;
		const resource = this.resource;
		this.resource = undefined;
		if (resource) this.retire(resource);
	}

	private retire(resource: T): void {
		resource.setActiveToolsByName([]);
		const job = Promise.resolve().then(() => resource.abort()).catch(() => undefined)
			.finally(() => { resource.dispose(); this.retiring.delete(job); });
		this.retiring.add(job);
	}

	async whenSettled(): Promise<void> {
		while (this.retiring.size) await Promise.all([...this.retiring]);
	}
}
