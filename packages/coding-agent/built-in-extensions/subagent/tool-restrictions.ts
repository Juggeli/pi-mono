/**
 * Per-agent tool restriction resolution.
 *
 * Replaces the old tools-filter.ts approach. Instead of filtering a string list,
 * this module resolves a full Tool[] set from allow/deny maps.
 */

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolRestrictions } from "./types.js";

// Each tool factory returns a differently-typed AgentTool, so we use a generic creator type
type ToolCreator = (cwd: string) => any;

/** Default restrictions for subagent-mode agents — prevents fork-bombing */
export const SUBAGENT_DEFAULTS: AgentToolRestrictions = {
	subagent: false,
};

/** Restrictions for the explore agent — read-only */
export const EXPLORE_RESTRICTIONS: AgentToolRestrictions = {
	...SUBAGENT_DEFAULTS,
	write: false,
	edit: false,
};

/** Restrictions for the review agent — read-only */
export const REVIEW_RESTRICTIONS: AgentToolRestrictions = {
	...SUBAGENT_DEFAULTS,
	write: false,
	edit: false,
};

/** Restrictions for the librarian agent — read-only, keeps extension tools */
export const LIBRARIAN_RESTRICTIONS: AgentToolRestrictions = {
	...SUBAGENT_DEFAULTS,
	write: false,
	edit: false,
};

/** Restrictions for the oracle agent — read-only */
export const ORACLE_RESTRICTIONS: AgentToolRestrictions = {
	...SUBAGENT_DEFAULTS,
	write: false,
	edit: false,
};

/** Restrictions for the metis agent — read-only */
export const METIS_RESTRICTIONS: AgentToolRestrictions = {
	...SUBAGENT_DEFAULTS,
	write: false,
	edit: false,
};

/** Restrictions for the momus agent — read-only */
export const MOMUS_RESTRICTIONS: AgentToolRestrictions = {
	...SUBAGENT_DEFAULTS,
	write: false,
	edit: false,
};

/** Restrictions for the atlas agent — read-only but keeps subagent access for delegation */
export const ATLAS_RESTRICTIONS: AgentToolRestrictions = {
	write: false,
	edit: false,
};

/** Restrictions for the prometheus agent — read-only but keeps subagent access */
export const PROMETHEUS_RESTRICTIONS: AgentToolRestrictions = {
	write: false,
	edit: false,
};

/** All individual tool creators keyed by name */
const TOOL_CREATORS: Record<string, ToolCreator> = {
	read: (cwd) => createReadTool(cwd),
	bash: (cwd) => createBashTool(cwd),
	edit: (cwd) => createEditTool(cwd),
	write: (cwd) => createWriteTool(cwd),
	grep: (cwd) => createGrepTool(cwd),
	find: (cwd) => createFindTool(cwd),
	ls: (cwd) => createLsTool(cwd),
};

/** All available built-in tool names */
export const ALL_TOOL_NAMES = Object.keys(TOOL_CREATORS);

/**
 * Resolve a filtered tool set based on the restrictions map.
 *
 * The base set is all available built-in tools. Tools explicitly set to `false`
 * in the restrictions map are removed. Tools set to `true` or not listed are kept.
 */
export function resolveTools(cwd: string, restrictions: AgentToolRestrictions) {
	const tools: any[] = [];

	for (const [name, creator] of Object.entries(TOOL_CREATORS)) {
		// If explicitly denied, skip
		if (restrictions[name] === false) continue;
		tools.push(creator(cwd));
	}

	return tools;
}

/**
 * Get the list of tool names that would be allowed given restrictions.
 * Useful for testing without needing cwd.
 */
export function resolveToolNames(restrictions: AgentToolRestrictions): string[] {
	return ALL_TOOL_NAMES.filter((name) => restrictions[name] !== false);
}
