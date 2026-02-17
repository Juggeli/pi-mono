/**
 * Concurrency management — per-model slot limiting.
 *
 * Simple semaphore that limits how many concurrent agent runs
 * can happen for each model string.
 */

interface Waiter {
	resolve: () => void;
}

export class ConcurrencyManager {
	private readonly defaultLimit: number;
	private readonly running = new Map<string, number>();
	private readonly waiters = new Map<string, Waiter[]>();

	constructor(defaultLimit = 4) {
		this.defaultLimit = defaultLimit;
	}

	/** Acquire a slot for the given model. Blocks until a slot is available. */
	async acquire(model: string): Promise<void> {
		const current = this.running.get(model) ?? 0;
		if (current < this.defaultLimit) {
			this.running.set(model, current + 1);
			return;
		}

		// Wait for a slot
		return new Promise<void>((resolve) => {
			const queue = this.waiters.get(model) ?? [];
			queue.push({ resolve });
			this.waiters.set(model, queue);
		});
	}

	/** Release a slot for the given model. Wakes the next waiter if any. */
	release(model: string): void {
		const current = this.running.get(model) ?? 0;
		if (current <= 0) return;

		const queue = this.waiters.get(model);
		if (queue && queue.length > 0) {
			// Hand the slot directly to the next waiter
			const waiter = queue.shift()!;
			if (queue.length === 0) this.waiters.delete(model);
			waiter.resolve();
		} else {
			this.running.set(model, current - 1);
			if (current - 1 === 0) this.running.delete(model);
		}
	}

	/** Get the number of currently running tasks for a model */
	getRunning(model: string): number {
		return this.running.get(model) ?? 0;
	}

	/** Get the total number of running tasks across all models */
	getTotalRunning(): number {
		let total = 0;
		for (const count of this.running.values()) total += count;
		return total;
	}
}
