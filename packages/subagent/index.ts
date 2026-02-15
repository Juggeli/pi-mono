/**
 * Subagent Tool - Delegate tasks to pi subprocesses with session persistence
 * 
 * Spawns pi with --session for resume support
 * Returns session path for potential continuation
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type ExtensionContext, type AgentToolResult, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.js";
import { filterSubagentTools } from "./tools-filter.js";

// =============================================================================
// Constants
// =============================================================================

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// Subagent sessions stored in dedicated subdir
const SUBAGENT_SESSIONS_DIR = path.join(os.homedir(), ".pi/agent/sessions/subagents");

// =============================================================================
// Types
// =============================================================================

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	sessionFile?: string;
	sessionId?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	// Real-time activity tracking
	currentActivity?: string;
	partialOutput?: string;
	lastToolCall?: { name: string; args: Record<string, unknown> };
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

interface SubagentParams {
	agent?: string;
	task?: string;
	session?: string;        // Path to existing session file (for resume)
	resume?: boolean;        // Resume existing session
	tasks?: Array<{
		agent: string;
		task: string;
		session?: string;
		resume?: boolean;
	}>;
	chain?: Array<{
		agent: string;
		task: string;
		session?: string;
		resume?: boolean;
	}>;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
}

// =============================================================================
// Utilities
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
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if ((part as any).type === "toolCall") items.push({ type: "toolCall", name: (part as any).name, args: (part as any).arguments });
			}
		}
	}
	return items;
}

function ensureSubagentSessionsDir(): void {
	if (!fs.existsSync(SUBAGENT_SESSIONS_DIR)) {
		fs.mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
	}
}


function generateSessionPath(): string {
	ensureSubagentSessionsDir();
	const timestamp = Date.now();
	const uuid = randomUUID().slice(0, 8);
	return path.join(SUBAGENT_SESSIONS_DIR, `${timestamp}_${uuid}.jsonl`);
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
// Agent Execution
// =============================================================================

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	sessionFile: string | undefined,
	isResume: boolean,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available: ${available}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Determine session file
	const targetSessionFile = sessionFile ?? generateSessionPath();
	const sessionId = path.basename(targetSessionFile, ".jsonl");

	const args: string[] = [
		"--mode", "json",
		"-p",
		"--session", targetSessionFile,
	];
	
	if (agent.model) args.push("--model", agent.model);
	const filteredTools = filterSubagentTools(agent.tools);
	if (filteredTools.length > 0) {
		args.push("--tools", filteredTools.join(","));
	} else {
		// Always pass explicit tools to prevent subagent from getting defaults
		// that include 'subagent' and causing recursive fork bomb
		args.push("--tools", "read,bash,grep,find,ls");
	}

	// Add system prompt via file if provided
	let tmpPromptPath: string | null = null;
	let tmpPromptDir: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		sessionFile: targetSessionFile,
		sessionId,
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			// Build status text for content
			let statusText = "";
			if (currentResult.currentActivity) {
				statusText = currentResult.currentActivity;
			} else if (isResume) {
				statusText = "(resuming...)";
			} else {
				statusText = "(running...)";
			}
			
			// Add tool info if available
			if (currentResult.lastToolCall) {
				statusText += `\n→ ${currentResult.lastToolCall.name}`;
			}
			
			// Add partial output preview
			if (currentResult.partialOutput) {
				const preview = currentResult.partialOutput.slice(-200).replace(/\n/g, " ");
				statusText += `\n${preview}...`;
			}
			
			onUpdate({
				content: [{ type: "text", text: statusText }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
			tmpPromptDir = tmpDir;
			tmpPromptPath = path.join(tmpDir, "system.md");
			fs.writeFileSync(tmpPromptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { 
				cwd: defaultCwd, 
				shell: false, 
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENT: "1" }
			});
			let buffer = "";
			let partialText = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				switch (event.type) {
					case "agent_start":
						currentResult.currentActivity = "Starting...";
						emitUpdate();
						break;

					case "turn_start":
						currentResult.currentActivity = "Thinking...";
						partialText = "";
						emitUpdate();
						break;

					case "message_start":
						if (event.message?.role === "assistant") {
							currentResult.currentActivity = "Generating response...";
							emitUpdate();
						}
						break;

					case "message_update":
						if (event.assistantMessageEvent?.type === "text_delta") {
							partialText += event.assistantMessageEvent.delta || "";
							currentResult.partialOutput = partialText.slice(-500); // Keep last 500 chars
							emitUpdate();
						}
						break;

					case "message_end":
						if (event.message) {
							const msg = event.message as Message;
							currentResult.messages.push(msg);
							partialText = "";
							currentResult.partialOutput = undefined;

							if (msg.role === "assistant") {
								currentResult.usage.turns++;
								const usage = msg.usage;
								if (usage) {
									currentResult.usage.input += usage.input || 0;
									currentResult.usage.output += usage.output || 0;
									currentResult.usage.cacheRead += usage.cacheRead || 0;
									currentResult.usage.cacheWrite += usage.cacheWrite || 0;
									currentResult.usage.cost += usage.cost?.total || 0;
									currentResult.usage.contextTokens = usage.totalTokens || 0;
								}
								if (!currentResult.model && msg.model) currentResult.model = msg.model;
								if (msg.stopReason) currentResult.stopReason = msg.stopReason;
								if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
								currentResult.currentActivity = msg.stopReason === "toolUse" 
									? "Using tools..." 
									: "Complete";
							}
							emitUpdate();
						}
						break;

					case "tool_execution_start":
						currentResult.currentActivity = `Running ${event.toolName}...`;
						currentResult.lastToolCall = { name: event.toolName, args: event.args };
						emitUpdate();
						break;

					case "tool_execution_end":
						currentResult.currentActivity = "Processing result...";
						emitUpdate();
						break;

					case "tool_result_end":
						if (event.message) {
							currentResult.messages.push(event.message as Message);
							emitUpdate();
						}
						break;

					case "turn_end":
						currentResult.currentActivity = "Turn complete";
						emitUpdate();
						break;

					case "agent_end":
						currentResult.currentActivity = "Finished";
						emitUpdate();
						break;
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		}
		if (tmpPromptDir) {
			try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
		}
	}
}

// =============================================================================
// Schema
// =============================================================================

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
	session: Type.Optional(Type.String({ description: "Path to existing session file to resume" })),
	resume: Type.Optional(Type.Boolean({ description: "Resume existing session", default: false })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder" }),
	session: Type.Optional(Type.String({ description: "Path to existing session file to resume" })),
	resume: Type.Optional(Type.Boolean({ description: "Resume existing session", default: false })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use',
	default: "user",
});

const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode). Omit to list available agents." })),
	task: Type.Optional(Type.String({ description: "Task (single mode). Required with agent." })),
	session: Type.Optional(Type.String({ description: "Session file path to resume" })),
	resume: Type.Optional(Type.Boolean({ description: "Resume existing session", default: false })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Skip registration if running as a subagent (prevent fork bomb)
	if (process.env.PI_SUBAGENT) {
		return;
	}

	// Discover agents at load time to include in description
	const cwd = process.cwd();
	const discovery = discoverAgents(cwd, "both");
	const agents = discovery.agents;
	
	// Build agent list for description
	const agentList = agents.length > 0 
		? agents.map(a => `  • ${a.name}: ${a.description}`).join("\n")
		: "  (No agents found - create .md files in ~/.pi/agent/agents/)";
	
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized pi agents with isolated sessions.",
			"",
			"To see available agents, call without parameters (omit agent/task).",
			"",
			"Currently available agents (at extension load):",
			agentList,
			"",
			"Modes:",
			"  • Single: agent + task",
			"  • Parallel: tasks[] (concurrent)",
			"  • Chain: chain[] (sequential with {previous} placeholder)",
			"",
			"Resume:",
			"  • Set resume: true and session: '<path>' to continue a session",
			"  • Returns session file path for potential future resume",
			"",
			"Agents loaded from ~/.pi/agent/agents/*.md and .pi/agents/*.md",
		].join("\n"),
		parameters: SubagentParamsSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const executionDiscovery = discoverAgents(ctx.cwd, agentScope);
			const agents = executionDiscovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			// If no agents found at execution time, warn
			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No agents found. Create .md files in ~/.pi/agent/agents/" }],
					details: { mode: "single", results: [] } as SubagentDetails,
					isError: true,
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails = (mode: "single" | "parallel" | "chain") => (results: SingleResult[]): SubagentDetails => ({
				mode,
				results,
			});

			// If no mode specified, return list of available agents
			if (modeCount === 0) {
				const agentList = agents.map(a => `- ${a.name}: ${a.description}`).join("\n");
				const sources = executionDiscovery.projectAgentsDir 
					? `user (~/.pi/agent/agents) and project (${executionDiscovery.projectAgentsDir})`
					: "user (~/.pi/agent/agents)";
				return {
					content: [{ 
						type: "text", 
						text: `Available agents (${sources}):\n\n${agentList || "(none found)"}` 
					}],
					details: makeDetails("single")([]),
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Error: Provide exactly one mode (single/parallel/chain). Available: ${available}` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// Confirm project agents
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgents = new Set<string>();
				if (params.chain) for (const s of params.chain) requestedAgents.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgents.add(t.agent);
				if (params.agent) requestedAgents.add(params.agent);

				const projectAgents = Array.from(requestedAgents)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgents.length > 0) {
					const ok = await ctx.ui.confirm(
						"Run project agents?",
						`Agents: ${projectAgents.map((a) => a.name).join(", ")}\nSource: ${discovery.projectAgentsDir}\n\nOnly continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Cancelled: project agents not approved" }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
				}
			}

			// Chain mode
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

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.session,
						step.resume ?? false,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
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

			// Parallel mode
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
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running` }],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.session,
						t.resume ?? false,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages).slice(0, 100);
					return `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"} ${output}${output.length >= 100 ? "..." : ""}`;
				});

				return {
					content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n")}` }],
					details: makeDetails("parallel")(results),
				};
			}

			// Single mode
			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.session,
					params.resume ?? false,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);

				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent failed: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
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
			const scope = args.agentScope ?? "user";
			const isResume = args.resume || (args.tasks?.some((t: any) => t.resume)) || (args.chain?.some((s: any) => s.resume));

			if (args.chain && args.chain.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length})`);
				if (isResume) text += theme.fg("warning", " [resume]");
				text += theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 2); i++) {
					const s = args.chain[i];
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", s.agent)}${s.session ? theme.fg("dim", " (resume)") : ""}`;
				}
				if (args.chain.length > 2) text += `\n  ${theme.fg("muted", `...+${args.chain.length - 2}`)}`;
				return new Text(text, 0, 0);
			}

			if (args.tasks && args.tasks.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length})`);
				if (isResume) text += theme.fg("warning", " [resume]");
				text += theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 2)) {
					text += `\n  ${theme.fg("accent", t.agent)}${t.session ? theme.fg("dim", " (resume)") : ""}`;
				}
				if (args.tasks.length > 2) text += `\n  ${theme.fg("muted", `...+${args.tasks.length - 2}`)}`;
				return new Text(text, 0, 0);
			}

			const agent = args.agent || "...";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agent);
			if (isResume) text += theme.fg("warning", " [resume]");
			text += theme.fg("muted", ` [${scope}]`);
			if (args.task) {
				const preview = args.task.length > 50 ? `${args.task.slice(0, 50)}...` : args.task;
				text += `\n  ${theme.fg("dim", preview)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
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
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
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

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
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
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
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

						// Show tool calls
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

						// Show final output as markdown
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
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
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

						// Show tool calls
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

						// Show final output as markdown
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
			let header = theme.fg("accent", `${details.mode}: ${details.results.length}`);
			const lines = details.results.map((r) => {
				const icon = r.exitCode !== 0 ? theme.fg("error", "✗") : theme.fg("success", "✓");
				return `${icon} ${theme.fg("accent", r.agent)}`;
			});
			return new Text([header, ...lines].join("\n\n"), 0, 0);
		},
	});
}
