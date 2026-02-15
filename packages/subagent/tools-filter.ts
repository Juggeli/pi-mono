/**
 * Filter out 'subagent' from tools list to prevent recursive spawning.
 * Exported for testing.
 */
export function filterSubagentTools(tools: string[] | undefined): string[] {
	if (!tools || tools.length === 0) return [];
	return tools.filter((t) => t !== "subagent");
}
