/**
 * Agent registry — built-in agent discovery and lookup.
 */

import type { AgentConfig, AgentFactory, AgentMode } from "../types.js";
import { createCodeAgent } from "./code.js";
import { createExploreAgent } from "./explore.js";
import { createLibrarianAgent } from "./librarian.js";
import { createMetisAgent } from "./metis.js";
import { createOracleAgent } from "./oracle.js";
import { createPrometheusAgent } from "./prometheus.js";
import { createReviewAgent } from "./review.js";
import { createSisyphusJuniorAgent } from "./sisyphus-junior.js";

/** All built-in agent factories */
const BUILTIN_FACTORIES: AgentFactory[] = [
	createCodeAgent,
	createExploreAgent,
	createLibrarianAgent,
	createMetisAgent,
	createOracleAgent,
	createPrometheusAgent,
	createReviewAgent,
	createSisyphusJuniorAgent,
];

/** Create and cache the built-in agents map */
let cachedAgents: Map<string, AgentConfig> | undefined;

export function createBuiltinAgents(): Map<string, AgentConfig> {
	if (cachedAgents) return cachedAgents;

	cachedAgents = new Map();
	for (const factory of BUILTIN_FACTORIES) {
		const config = factory();
		cachedAgents.set(config.name, config);
	}
	return cachedAgents;
}

/** Get a single agent by name */
export function getAgent(name: string): AgentConfig | undefined {
	return createBuiltinAgents().get(name);
}

/** List agents, optionally filtered by mode */
export function listAgents(mode?: AgentMode): AgentConfig[] {
	const agents = Array.from(createBuiltinAgents().values());
	if (!mode) return agents;
	return agents.filter((a) => a.mode === mode || a.mode === "all");
}
