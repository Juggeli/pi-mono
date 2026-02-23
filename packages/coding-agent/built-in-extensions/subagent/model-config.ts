/**
 * Persisted subagent model overrides.
 *
 * Stores per-agent model assignments in ~/.pi/agent/subagent-models.json
 * so users can reassign models without editing source code.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const CONFIG_FILE = "subagent-models.json";

function getConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE);
}

export function loadModelOverrides(): Record<string, string> {
	try {
		const raw = fs.readFileSync(getConfigPath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}
		return {};
	} catch {
		return {};
	}
}

export function saveModelOverrides(overrides: Record<string, string>): void {
	const dir = getAgentDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(getConfigPath(), `${JSON.stringify(overrides, null, 2)}\n`, "utf-8");
}

export function getModelOverride(agentName: string): string | undefined {
	const overrides = loadModelOverrides();
	return overrides[agentName];
}

export function setModelOverride(agentName: string, model: string): void {
	const overrides = loadModelOverrides();
	overrides[agentName] = model;
	saveModelOverrides(overrides);
}

export function clearModelOverride(agentName: string): void {
	const overrides = loadModelOverrides();
	delete overrides[agentName];
	saveModelOverrides(overrides);
}
