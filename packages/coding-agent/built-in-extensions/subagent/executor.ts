/**
 * Agent executor — runs agents in-process using the SDK.
 *
 * Replaces the old subprocess-based execution with createAgentSession().
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { resolveTools } from "./tool-restrictions.js";
import type { AgentConfig, OnAgentEventCallback, SingleResult, TaskResult, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";

/**
 * Run an agent using the in-process SDK.
 *
 * Creates a child AgentSession with the agent's tool restrictions and system prompt,
 * executes the task, and returns the result. The session is kept alive for potential resume.
 */
export async function runAgent(
	agentConfig: AgentConfig,
	task: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onEvent?: OnAgentEventCallback,
): Promise<{ result: TaskResult; session: AgentSession }> {
	const cwd = ctx.cwd;

	// Resolve model from registry if specified
	let model = ctx.model;
	if (agentConfig.model && ctx.modelRegistry) {
		const allModels = ctx.modelRegistry.getAll();
		const found = allModels.find((m) => m.id === agentConfig.model);
		if (found) model = found;
	}

	// Build filtered tools
	const tools = resolveTools(cwd, agentConfig.tools);

	// Set PI_SUBAGENT to prevent fork-bombing when extensions are loaded
	if (agentConfig.loadExtensions) {
		process.env.PI_SUBAGENT = "1";
	}

	// Create resource loader — load extensions only when the agent requires them
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		noExtensions: !agentConfig.loadExtensions,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt: agentConfig.systemPrompt,
	});
	await resourceLoader.reload();

	// Create the child session
	const sessionOptions: CreateAgentSessionOptions = {
		cwd,
		modelRegistry: ctx.modelRegistry,
		model,
		tools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.create(cwd),
	};

	const { session } = await createAgentSession(sessionOptions);

	// Subscribe to events for real-time updates
	let unsubscribe: (() => void) | undefined;
	if (onEvent) {
		unsubscribe = session.subscribe(onEvent);
	}

	const usage: UsageStats = emptyUsage();

	// Track usage from events
	const usageUnsub = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const msg = event.message;
			usage.turns++;
			const msgUsage = msg.usage;
			if (msgUsage) {
				usage.input += msgUsage.input || 0;
				usage.output += msgUsage.output || 0;
				usage.cacheRead += msgUsage.cacheRead || 0;
				usage.cacheWrite += msgUsage.cacheWrite || 0;
				usage.cost += msgUsage.cost?.total || 0;
				usage.contextTokens = msgUsage.totalTokens || 0;
			}
		}
	});

	try {
		// Handle abort
		if (signal?.aborted) {
			throw new Error("Subagent was aborted");
		}

		let abortHandler: (() => void) | undefined;
		if (signal) {
			abortHandler = () => {
				session.abort();
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			// Execute the prompt
			await session.prompt(task, { expandPromptTemplates: false });
		} finally {
			if (signal && abortHandler) {
				signal.removeEventListener("abort", abortHandler);
			}
		}

		// Extract final output from messages
		const messages = session.messages as Message[];
		const finalOutput = extractFinalOutput(messages);
		const lastAssistant = findLastAssistant(messages);

		const result: TaskResult = {
			exitCode: lastAssistant?.errorMessage ? 1 : 0,
			messages,
			usage,
			finalOutput,
			errorMessage: lastAssistant?.errorMessage,
		};

		return { result, session };
	} catch (error) {
		const messages = session.messages as Message[];
		const errorMessage = error instanceof Error ? error.message : String(error);

		return {
			result: {
				exitCode: 1,
				messages,
				usage,
				finalOutput: "",
				errorMessage,
			},
			session,
		};
	} finally {
		unsubscribe?.();
		usageUnsub();
	}
}

/**
 * Resume an existing agent session with a new task.
 */
export async function resumeAgent(
	session: AgentSession,
	task: string,
	signal?: AbortSignal,
	onEvent?: OnAgentEventCallback,
): Promise<TaskResult> {
	let unsubscribe: (() => void) | undefined;
	if (onEvent) {
		unsubscribe = session.subscribe(onEvent);
	}

	const usage: UsageStats = emptyUsage();
	const usageUnsub = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const msg = event.message;
			usage.turns++;
			const msgUsage = msg.usage;
			if (msgUsage) {
				usage.input += msgUsage.input || 0;
				usage.output += msgUsage.output || 0;
				usage.cacheRead += msgUsage.cacheRead || 0;
				usage.cacheWrite += msgUsage.cacheWrite || 0;
				usage.cost += msgUsage.cost?.total || 0;
				usage.contextTokens = msgUsage.totalTokens || 0;
			}
		}
	});

	try {
		if (signal?.aborted) throw new Error("Subagent was aborted");

		let abortHandler: (() => void) | undefined;
		if (signal) {
			abortHandler = () => {
				session.abort();
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			await session.prompt(task, { expandPromptTemplates: false });
		} finally {
			if (signal && abortHandler) {
				signal.removeEventListener("abort", abortHandler);
			}
		}

		const messages = session.messages as Message[];
		const finalOutput = extractFinalOutput(messages);
		const lastAssistant = findLastAssistant(messages);

		return {
			exitCode: lastAssistant?.errorMessage ? 1 : 0,
			messages,
			usage,
			finalOutput,
			errorMessage: lastAssistant?.errorMessage,
		};
	} catch (error) {
		const messages = session.messages as Message[];
		return {
			exitCode: 1,
			messages,
			usage,
			finalOutput: "",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	} finally {
		unsubscribe?.();
		usageUnsub();
	}
}

/**
 * Build a SingleResult from a TaskResult for rendering purposes.
 */
export function toSingleResult(
	agentName: string,
	task: string,
	taskResult: TaskResult,
	sessionId?: string,
	step?: number,
): SingleResult {
	return {
		agent: agentName,
		task,
		exitCode: taskResult.exitCode,
		messages: taskResult.messages,
		usage: taskResult.usage,
		sessionId,
		errorMessage: taskResult.errorMessage,
		step,
	};
}

// =============================================================================
// Helpers
// =============================================================================

function extractFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function findLastAssistant(messages: Message[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}
