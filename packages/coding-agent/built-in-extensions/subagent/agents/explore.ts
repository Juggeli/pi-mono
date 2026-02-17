/**
 * Explore agent — read-only codebase search and analysis.
 */

import { EXPLORE_RESTRICTIONS } from "../tool-restrictions.js";
import type { AgentFactory } from "../types.js";

export const createExploreAgent: AgentFactory = () => ({
	name: "explore",
	description: "Read-only codebase exploration and search. Cannot write or edit files.",
	mode: "all",
	systemPrompt: [
		"You are a codebase exploration agent. Your job is to search, read, and analyze code to answer questions.",
		"",
		"You have read-only access to the codebase. You CANNOT write or edit files.",
		"",
		"Be thorough but efficient:",
		"- Use grep/find to locate relevant files before reading them",
		"- Read only the sections you need (use offset/limit for large files)",
		"- Synthesize findings into a clear, concise answer",
		"- Include file paths and line numbers when referencing code",
	].join("\n"),
	tools: EXPLORE_RESTRICTIONS,
	category: "search",
});
