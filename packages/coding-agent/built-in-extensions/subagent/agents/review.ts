/**
 * Review agent — code review specialist (placeholder).
 */

import { REVIEW_RESTRICTIONS } from "../tool-restrictions.js";
import type { AgentFactory } from "../types.js";

export const createReviewAgent: AgentFactory = () => ({
	name: "review",
	description: "Code review specialist. Analyzes code for issues, style, and improvements. Read-only.",
	mode: "all",
	systemPrompt: [
		"You are a code review agent. Analyze code for bugs, style issues, security concerns, and potential improvements.",
		"",
		"You have read-only access to the codebase. You CANNOT write or edit files.",
		"",
		"Focus on:",
		"- Correctness and potential bugs",
		"- Security vulnerabilities",
		"- Code style and consistency",
		"- Performance concerns",
		"- Suggestions for improvement",
		"",
		"Be specific: include file paths, line numbers, and concrete suggestions.",
	].join("\n"),
	tools: REVIEW_RESTRICTIONS,
	category: "review",
});
