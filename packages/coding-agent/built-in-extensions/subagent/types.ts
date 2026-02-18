/**
 * Shared types for the subagent extension.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Agent Configuration
// =============================================================================

/** Agent execution mode — controls where the agent can be used */
export type AgentMode = "primary" | "subagent" | "all";

/**
 * Per-agent tool restrictions.
 * true = allowed, false = denied. Unlisted tools use default (allowed).
 */
export interface AgentToolRestrictions {
	[toolName: string]: boolean;
}

/** Configuration for a single agent */
export interface AgentConfig {
	name: string;
	description: string;
	mode: AgentMode;
	model?: string;
	temperature?: number;
	systemPrompt: string;
	tools: AgentToolRestrictions;
	category?: string;
	/** When true, load extensions in the child session (gives access to exa_search, grep_code_search, etc.) */
	loadExtensions?: boolean;
}

/** Factory function that produces an AgentConfig */
export type AgentFactory = () => AgentConfig;

// =============================================================================
// Usage & Results
// =============================================================================

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface TaskResult {
	exitCode: number;
	messages: Message[];
	usage: UsageStats;
	finalOutput: string;
	errorMessage?: string;
}

// =============================================================================
// Background Tasks
// =============================================================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface TaskState {
	id: string;
	description: string;
	agent: string;
	status: TaskStatus;
	session: AgentSession;
	/** Stable resume session ID, assigned once when the task completes */
	sessionId?: string;
	result?: TaskResult;
	startedAt: number;
	completedAt?: number;
}

// =============================================================================
// Tool Details (for renderCall / renderResult)
// =============================================================================

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	usage: UsageStats;
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

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "background" | "taskStatus";
	results: SingleResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

// =============================================================================
// Callbacks
// =============================================================================

export type OnUpdateCallback = (partial: {
	content: { type: "text"; text: string }[];
	details: SubagentDetails;
}) => void;

export type OnAgentEventCallback = (event: AgentSessionEvent) => void;

// =============================================================================
// Constants
// =============================================================================

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
