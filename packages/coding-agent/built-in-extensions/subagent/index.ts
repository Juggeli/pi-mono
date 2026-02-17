/**
 * Subagent Tool — Delegate tasks to in-process agent sessions via the SDK.
 *
 * Supports single, parallel, chain, and background execution modes.
 * Sessions are kept alive in memory for resume within parent session lifetime.
 */

import * as os from "node:os";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type AgentSession, type AgentSessionEvent, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getAgent, listAgents } from "./agents/index.js";
import { ConcurrencyManager } from "./concurrency.js";
import { resumeAgent, runAgent, toSingleResult } from "./executor.js";
import { BackgroundTaskManager } from "./task-manager.js";
import type { DisplayItem, OnUpdateCallback, SingleResult, SubagentDetails, UsageStats } from "./types.js";
import { COLLAPSED_ITEM_COUNT, emptyUsage, MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "./types.js";

// =============================================================================
// Session tracking (in-memory, keyed by session ID)
// =============================================================================

const liveSessions = new Map<string, AgentSession>();
let sessionCounter = 0;

function trackSession(session: AgentSession): string {
	const id = `sa-${++sessionCounter}`;
	liveSessions.set(id, session);
	return id;
}

// =============================================================================
// Utilities (kept from original)
// =============================================================================

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
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

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// =============================================================================
// Schema
// =============================================================================

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
	session: Type.Optional(Type.String({ description: "Session ID to resume (returned from previous call)" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder" }),
	session: Type.Optional(Type.String({ description: "Session ID to resume" })),
});

const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode). Omit to list available agents." })),
	task: Type.Optional(Type.String({ description: "Task (single mode). Required with agent." })),
	session: Type.Optional(Type.String({ description: "Session ID to resume (returned from previous call)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain" })),
	background: Type.Optional(Type.Boolean({ description: "Run in background, return task ID" })),
	checkTask: Type.Optional(Type.String({ description: "Get status/result of background task" })),
	abortTask: Type.Optional(Type.String({ description: "Abort a background task" })),
	listTasks: Type.Optional(Type.Boolean({ description: "List all active/completed tasks" })),
	waitTasks: Type.Optional(Type.Boolean({ description: "Block until all background tasks complete, return results" })),
});

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Skip registration if running as a subagent (prevent fork bomb — safety net)
	if (process.env.PI_SUBAGENT) {
		return;
	}

	const concurrency = new ConcurrencyManager(MAX_CONCURRENCY);
	const taskManager = new BackgroundTaskManager(concurrency, pi);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized agents with isolated in-process sessions.",
			"",
			"To see available agents, call without parameters (omit agent/task).",
			"",
			"Modes:",
			"  • Single: agent + task",
			"  • Parallel: tasks[] (concurrent)",
			"  • Chain: chain[] (sequential with {previous} placeholder)",
			"  • Background: agent + task + background:true (returns task ID)",
			"",
			"Resume: pass session ID (from previous result) to continue a conversation.",
			"",
			"Background tasks:",
			"  • checkTask: get status/result of background task",
			"  • abortTask: abort a background task",
			"  • listTasks: list all background tasks",
			"  • waitTasks: block until all background tasks complete",
		].join("\n"),
		parameters: SubagentParamsSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = listAgents();

			// ─── Task management operations ───────────────────────────

			if (params.checkTask) {
				const task = taskManager.getTask(params.checkTask);
				if (!task) {
					return {
						content: [{ type: "text", text: `No task found with ID: ${params.checkTask}` }],
						details: { mode: "taskStatus", results: [] } as SubagentDetails,
						isError: true,
					};
				}
				const statusText = task.result
					? `Task ${task.id} (${task.agent}): ${task.status}\n\n${task.result.finalOutput || "(no output)"}`
					: `Task ${task.id} (${task.agent}): ${task.status}`;

				// Assign a stable session ID once (on first check after completion)
				let sessionId = task.sessionId;
				if (!sessionId && task.session) {
					sessionId = trackSession(task.session);
					task.sessionId = sessionId;
				}

				return {
					content: [{ type: "text", text: statusText + (sessionId ? `\n\nSession: ${sessionId}` : "") }],
					details: {
						mode: "taskStatus",
						results: task.result ? [toSingleResult(task.agent, task.description, task.result, sessionId)] : [],
					} as SubagentDetails,
				};
			}

			if (params.abortTask) {
				await taskManager.abortTask(params.abortTask);
				return {
					content: [{ type: "text", text: `Abort requested for task: ${params.abortTask}` }],
					details: { mode: "taskStatus", results: [] } as SubagentDetails,
				};
			}

			if (params.listTasks) {
				const allTasks = taskManager.listTasks();
				if (allTasks.length === 0) {
					return {
						content: [{ type: "text", text: "No background tasks." }],
						details: { mode: "taskStatus", results: [] } as SubagentDetails,
					};
				}
				const lines = allTasks.map((t) => {
					const elapsed = t.completedAt
						? `${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s`
						: `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s...`;
					return `- ${t.id} [${t.agent}] ${t.status} (${elapsed}): ${t.description.slice(0, 80)}`;
				});
				return {
					content: [{ type: "text", text: `Background tasks:\n\n${lines.join("\n")}` }],
					details: { mode: "taskStatus", results: [] } as SubagentDetails,
				};
			}

			if (params.waitTasks) {
				const completedTasks = await taskManager.waitAll(signal);
				if (completedTasks.length === 0) {
					return {
						content: [{ type: "text", text: "No active background tasks to wait for." }],
						details: { mode: "taskStatus", results: [] } as SubagentDetails,
					};
				}
				const lines = completedTasks.map((t) => {
					const elapsed = t.completedAt
						? `${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s`
						: `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s...`;
					return `- ${t.id} [${t.agent}] ${t.status} (${elapsed}): ${t.description.slice(0, 80)}`;
				});
				return {
					content: [{ type: "text", text: `All background tasks completed:\n\n${lines.join("\n")}` }],
					details: { mode: "taskStatus", results: [] } as SubagentDetails,
				};
			}

			// ─── Determine execution mode ─────────────────────────────

			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No agents configured." }],
					details: { mode: "single", results: [] } as SubagentDetails,
					isError: true,
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: SubagentDetails["mode"]) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					results,
				});

			// If no mode specified, return list of available agents
			if (modeCount === 0) {
				const agentList = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `Available agents:\n\n${agentList || "(none found)"}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Error: Provide exactly one mode (single/parallel/chain). Available: ${available}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// ─── Helper: run single agent ─────────────────────────────

			const runSingle = async (
				agentName: string,
				task: string,
				sessionId: string | undefined,
				step: number | undefined,
				taskSignal: AbortSignal | undefined,
				taskOnUpdate: OnUpdateCallback | undefined,
				taskMakeDetails: (results: SingleResult[]) => SubagentDetails,
			): Promise<SingleResult> => {
				const agentConfig = getAgent(agentName);
				if (!agentConfig) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						agent: agentName,
						task,
						exitCode: 1,
						messages: [],
						usage: emptyUsage(),
						errorMessage: `Unknown agent: "${agentName}". Available: ${available}`,
						step,
					};
				}

				const currentResult: SingleResult = {
					agent: agentName,
					task,
					exitCode: 0,
					messages: [],
					usage: emptyUsage(),
					step,
				};

				const emitUpdate = () => {
					if (taskOnUpdate) {
						let statusText = currentResult.currentActivity || "(running...)";
						if (currentResult.lastToolCall) {
							statusText += `\n→ ${currentResult.lastToolCall.name}`;
						}
						if (currentResult.partialOutput) {
							const preview = currentResult.partialOutput.slice(-200).replace(/\n/g, " ");
							statusText += `\n${preview}...`;
						}
						taskOnUpdate({
							content: [{ type: "text", text: statusText }],
							details: taskMakeDetails([currentResult]),
						});
					}
				};

				// Check for session resume
				if (sessionId && !liveSessions.has(sessionId)) {
					return {
						agent: agentName,
						task,
						exitCode: 1,
						messages: [],
						usage: emptyUsage(),
						errorMessage: `Session not found: "${sessionId}". It may have expired or the ID is incorrect.`,
						step,
					};
				}
				const existingSession = sessionId ? liveSessions.get(sessionId) : undefined;

				try {
					let resultData: { result: import("./types.js").TaskResult; session?: AgentSession };

					if (existingSession) {
						// Resume existing session
						currentResult.currentActivity = "Resuming...";
						currentResult.sessionId = sessionId;
						emitUpdate();

						const onEvent = (event: AgentSessionEvent) => {
							handleAgentEvent(event, currentResult, emitUpdate);
						};

						const taskResult = await resumeAgent(existingSession, task, taskSignal, onEvent);
						resultData = { result: taskResult };
						// Session is already tracked
					} else {
						// New session
						currentResult.currentActivity = "Starting...";
						emitUpdate();

						const onEvent = (event: AgentSessionEvent) => {
							handleAgentEvent(event, currentResult, emitUpdate);
						};

						const { result, session } = await runAgent(agentConfig, task, ctx, taskSignal, onEvent);
						const newSessionId = trackSession(session);
						currentResult.sessionId = newSessionId;
						resultData = { result };
					}

					currentResult.exitCode = resultData.result.exitCode;
					currentResult.messages = resultData.result.messages;
					currentResult.usage = resultData.result.usage;
					currentResult.errorMessage = resultData.result.errorMessage;
					currentResult.currentActivity = "Finished";
					emitUpdate();
					return currentResult;
				} catch (error) {
					currentResult.exitCode = 1;
					currentResult.errorMessage = error instanceof Error ? error.message : String(error);
					return currentResult;
				}
			};

			// ─── Background mode ──────────────────────────────────────

			if (params.background && params.agent && params.task) {
				const agentConfig = getAgent(params.agent);
				if (!agentConfig) {
					return {
						content: [{ type: "text", text: `Unknown agent: "${params.agent}"` }],
						details: makeDetails("background")([]),
						isError: true,
					};
				}

				const taskState = await taskManager.launch({
					agent: agentConfig,
					task: params.task,
					ctx,
				});

				return {
					content: [
						{
							type: "text",
							text: `Background task launched: ${taskState.id}\nAgent: ${taskState.agent}\nTask: ${params.task}\n\nUse checkTask: "${taskState.id}" to check status.`,
						},
					],
					details: makeDetails("background")([]),
				};
			}

			// ─── Chain mode ───────────────────────────────────────────

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const current = partial.details?.results[0];
								if (current) {
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")([...results, current]),
									});
								}
							}
						: undefined;

					const result = await runSingle(
						step.agent,
						taskWithContext,
						step.session,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					if (result.exitCode !== 0) {
						const errorMsg = result.errorMessage || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}

				const final = results[results.length - 1];
				return {
					content: [{ type: "text", text: getFinalOutput(final.messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// ─── Parallel mode ────────────────────────────────────────

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Error: Max ${MAX_PARALLEL_TASKS} parallel tasks` }],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						usage: emptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingle(
						t.agent,
						t.task,
						t.session,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages).slice(0, 100);
					return `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"} ${output}${output.length >= 100 ? "..." : ""}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// ─── Single mode ──────────────────────────────────────────

			if (params.agent && params.task) {
				const result = await runSingle(
					params.agent,
					params.task,
					params.session,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);

				if (result.exitCode !== 0) {
					const errorMsg = result.errorMessage || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent failed: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}

				const outputText = getFinalOutput(result.messages) || "(no output)";
				const sessionInfo = result.sessionId ? `\n\nSession: ${result.sessionId}` : "";
				return {
					content: [{ type: "text", text: outputText + sessionInfo }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available: ${available}` }],
				details: makeDetails("single")([]),
				isError: true,
			};
		},

		renderCall(args, theme) {
			if (args.checkTask) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `check ${args.checkTask}`),
					0,
					0,
				);
			}
			if (args.abortTask) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("warning", `abort ${args.abortTask}`),
					0,
					0,
				);
			}
			if (args.listTasks) {
				return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "list tasks"), 0, 0);
			}
			if (args.waitTasks) {
				return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "wait tasks"), 0, 0);
			}

			const isResume =
				args.session || args.tasks?.some((t: any) => t.session) || args.chain?.some((s: any) => s.session);

			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length})`);
				if (isResume) text += theme.fg("warning", " [resume]");
				if (args.background) text += theme.fg("dim", " [bg]");
				for (let i = 0; i < Math.min(args.chain.length, 2); i++) {
					const s = args.chain[i];
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", s.agent)}${s.session ? theme.fg("dim", " (resume)") : ""}`;
				}
				if (args.chain.length > 2) text += `\n  ${theme.fg("muted", `...+${args.chain.length - 2}`)}`;
				return new Text(text, 0, 0);
			}

			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length})`);
				if (isResume) text += theme.fg("warning", " [resume]");
				for (const t of args.tasks.slice(0, 2)) {
					text += `\n  ${theme.fg("accent", t.agent)}${t.session ? theme.fg("dim", " (resume)") : ""}`;
				}
				if (args.tasks.length > 2) text += `\n  ${theme.fg("muted", `...+${args.tasks.length - 2}`)}`;
				return new Text(text, 0, 0);
			}

			const agent = args.agent || "...";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agent);
			if (isResume) text += theme.fg("warning", " [resume]");
			if (args.background) text += theme.fg("dim", " [bg]");
			if (args.task) {
				const preview = args.task.length > 50 ? `${args.task.slice(0, 50)}...` : args.task;
				text += `\n  ${theme.fg("dim", preview)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;

			if (details?.mode === "taskStatus" || details?.mode === "background") {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0;
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
					if (r.sessionId) header += theme.fg("dim", ` [${r.sessionId}]`);
					if (isError && r.errorMessage) header += ` ${theme.fg("error", `[error]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsage(r.usage);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
				if (r.sessionId) text += theme.fg("dim", ` [${r.sessionId}]`);
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsage(r.usage);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total: UsageStats = emptyUsage();
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
					total.contextTokens += r.usage.contextTokens;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsage(r.usage);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const totalUsage = formatUsage(aggregateUsage(details.results));
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const totalUsage = formatUsage(aggregateUsage(details.results));
				if (totalUsage) text += `\n${theme.fg("dim", totalUsage)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsage(r.usage);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const totalUsage = formatUsage(aggregateUsage(details.results));
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const totalUsage = formatUsage(aggregateUsage(details.results));
				if (totalUsage) text += `\n${theme.fg("dim", totalUsage)}`;
				return new Text(text, 0, 0);
			}

			// Fallback
			const header = theme.fg("accent", `${details.mode}: ${details.results.length}`);
			const lines = details.results.map((r) => {
				const icon = r.exitCode !== 0 ? theme.fg("error", "✗") : theme.fg("success", "✓");
				return `${icon} ${theme.fg("accent", r.agent)}`;
			});
			return new Text([header, ...lines].join("\n\n"), 0, 0);
		},
	});
}

// =============================================================================
// Event handler for real-time tracking
// =============================================================================

function handleAgentEvent(event: AgentSessionEvent, result: SingleResult, emitUpdate: () => void): void {
	switch (event.type) {
		case "agent_start":
			result.currentActivity = "Starting...";
			emitUpdate();
			break;

		case "turn_start":
			result.currentActivity = "Thinking...";
			emitUpdate();
			break;

		case "message_start":
			if (event.message?.role === "assistant") {
				result.currentActivity = "Generating response...";
				emitUpdate();
			}
			break;

		case "message_update":
			if (event.assistantMessageEvent?.type === "text_delta") {
				const delta = (event.assistantMessageEvent as any).delta || "";
				result.partialOutput = ((result.partialOutput || "") + delta).slice(-500);
				emitUpdate();
			}
			break;

		case "message_end":
			if (event.message) {
				result.partialOutput = undefined;
				if (event.message.role === "assistant") {
					const msg = event.message;
					result.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!result.model && msg.model) result.model = msg.model;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					result.currentActivity = msg.stopReason === "toolUse" ? "Using tools..." : "Complete";
				}
				emitUpdate();
			}
			break;

		case "tool_execution_start":
			result.currentActivity = `Running ${event.toolName}...`;
			result.lastToolCall = { name: event.toolName, args: event.args };
			emitUpdate();
			break;

		case "tool_execution_end":
			result.currentActivity = "Processing result...";
			emitUpdate();
			break;

		case "turn_end":
			result.currentActivity = "Turn complete";
			emitUpdate();
			break;

		case "agent_end":
			result.currentActivity = "Finished";
			emitUpdate();
			break;
	}
}
