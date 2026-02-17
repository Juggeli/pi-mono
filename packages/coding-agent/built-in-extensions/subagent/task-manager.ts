/**
 * Background task manager — async task lifecycle with completion notification.
 *
 * Tasks run in background via unblocked promises. When a background task completes,
 * the manager calls `pi.sendMessage()` to inject a system message into the parent
 * session with the task result.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ConcurrencyManager } from "./concurrency.js";
import { runAgent } from "./executor.js";
import type { AgentConfig, TaskResult, TaskState } from "./types.js";
import { emptyUsage } from "./types.js";

export class BackgroundTaskManager {
	private readonly tasks = new Map<string, TaskState>();
	private readonly abortControllers = new Map<string, AbortController>();
	private readonly concurrency: ConcurrencyManager;
	private readonly pi: ExtensionAPI;

	constructor(concurrency: ConcurrencyManager, pi: ExtensionAPI) {
		this.concurrency = concurrency;
		this.pi = pi;
	}

	/**
	 * Launch a background task. Returns immediately with the TaskState (status: "pending").
	 * The task runs asynchronously and notifies the parent session on completion.
	 */
	async launch(params: { agent: AgentConfig; task: string; ctx: ExtensionContext }): Promise<TaskState> {
		const id = randomUUID().slice(0, 8);
		const abortController = new AbortController();

		// Create a placeholder session — will be replaced once the agent starts
		const state: TaskState = {
			id,
			description: params.task,
			agent: params.agent.name,
			status: "pending",
			session: undefined as unknown as AgentSession, // Set once agent starts
			startedAt: Date.now(),
		};

		this.tasks.set(id, state);
		this.abortControllers.set(id, abortController);

		const modelKey = params.agent.model ?? "default";

		// Fire and forget — don't await
		void (async () => {
			try {
				await this.concurrency.acquire(modelKey);

				// Check if aborted while waiting for concurrency slot
				if (abortController.signal.aborted) {
					state.status = "aborted";
					state.completedAt = Date.now();
					return;
				}

				state.status = "running";

				const { result, session } = await runAgent(params.agent, params.task, params.ctx, abortController.signal);

				state.session = session;
				state.result = result;

				// Distinguish abort from genuine failure
				if (abortController.signal.aborted) {
					state.status = "aborted";
				} else {
					state.status = result.exitCode === 0 ? "completed" : "failed";
				}
				state.completedAt = Date.now();
			} catch (error) {
				state.status = abortController.signal.aborted ? "aborted" : "failed";
				state.completedAt = Date.now();
				state.result = {
					exitCode: 1,
					messages: [],
					usage: emptyUsage(),
					finalOutput: "",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
			} finally {
				this.concurrency.release(modelKey);
				this.abortControllers.delete(id);
				this.notifyCompletion(state);
			}
		})();

		return state;
	}

	/** Get a task by ID */
	getTask(id: string): TaskState | undefined {
		return this.tasks.get(id);
	}

	/** List all tasks */
	listTasks(): TaskState[] {
		return Array.from(this.tasks.values());
	}

	/** Abort a running task */
	async abortTask(id: string): Promise<void> {
		const controller = this.abortControllers.get(id);
		if (controller) {
			controller.abort();
		}
		const task = this.tasks.get(id);
		if (task && (task.status === "pending" || task.status === "running")) {
			task.status = "aborted";
			task.completedAt = Date.now();
		}
	}

	/** Get result of a completed task */
	getResult(id: string): TaskResult | undefined {
		return this.tasks.get(id)?.result;
	}

	/** Notify the parent session that a background task completed */
	private notifyCompletion(task: TaskState): void {
		const status = task.status === "completed" ? "completed" : `failed (${task.result?.errorMessage ?? "unknown"})`;
		const output = task.result?.finalOutput ? `\n\nOutput:\n${task.result.finalOutput.slice(0, 2000)}` : "";

		const text = `Background task ${task.id} (${task.agent}): ${status}${output}`;

		// Send as a user message so it always triggers a turn.
		// If the agent is currently streaming, it gets queued as a follow-up.
		this.pi.sendUserMessage(text, { deliverAs: "followUp" });
	}
}
