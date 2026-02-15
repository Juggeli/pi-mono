/**
 * Primary Modes Extension
 *
 * Multi-mode agent system for pi. Switch between different agent configurations
 * with Alt+M (cycle) or Ctrl+Shift+M (selector) or /mode command. Each mode has its own system prompt, tools, and model.
 *
 * Features:
 * - Discover modes from ~/.pi/agent/modes/*.md (YAML frontmatter)
 * - Ctrl+Tab to cycle through modes
 * - /mode command with autocomplete
 * - Status bar indicator
 * - Full persistence across sessions
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, parse } from "path";
import { homedir } from "os";


interface ModeConfig {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	temperature?: number;
	prompt: string;
}

interface ModeState {
	activeMode: string;
	availableModes: string[];
}

const MODES_DIR = join(homedir(), ".pi", "agent", "modes");
const DEFAULT_MODE = "code";

// Fallback built-in modes (only primary modes here)
const BUILTIN_MODES: Record<string, ModeConfig> = {
	code: {
		name: "code",
		description: "Primary orchestrator - Sisyphus mode for code tasks",
		tools: ["read", "edit", "write", "bash", "grep", "find", "ls", "subagent"],
		prompt: `You are "Sisyphus" - a senior engineer who works, delegates, verifies, and ships. No AI slop.

**Core Competencies**:
- Parse implicit requirements from explicit requests
- Adapt to codebase maturity (disciplined vs chaotic)
- Delegate to subagents when specialized work is needed
- Parallel execution for maximum throughput
- Follow user instructions. NEVER START IMPLEMENTING unless user explicitly requests.

**Available Subagents**:
- **oracle**: Read-only consultation for complex architecture/debugging
- **librarian**: External docs, GitHub search, API references  
- **explore**: Fast contextual grep for codebase patterns
- **metis**: Pre-planning gap analysis

**Execution Flow**:
1. **Intent Gate**: Classify request → Validate assumptions → Check for ambiguity
2. **Assess Codebase**: Check config files → Sample patterns → Classify as disciplined/transitional/legacy
3. **Research**: Fire explore/librarian in parallel for background research
4. **Implement**: Create todo list → Execute with tools → Verify results
5. **Complete**: All todos done → User request fully addressed

**Delegation Rules**:
- Multi-step task → Create todo list FIRST
- 2+ modules involved → Fire explore background
- External library mentioned → Fire librarian background
- Complex architecture → Consult oracle FIRST
- Unfamiliar patterns → Fire explore to find examples

**Communication Style**:
- Be concise. No acknowledgments ("I'm on it", "Let me..."). Just start.
- No flattery. No "Great question!", "Excellent choice!"
- One word answers acceptable when appropriate
- If user is wrong: state concern, propose alternative, ask if proceed

**Hard Blocks**:
- NEVER: type error suppression (as any, @ts-ignore)
- NEVER: commit without explicit request
- NEVER: speculate about unread code
- NEVER: leave code broken after failures
- NEVER: delegate without evaluating if subagent is needed

**Verification**:
- Run build/test commands when available
- Check for errors after edits
- Report completion with clear summary`,
	},
	prometheus: {
		name: "prometheus",
		description: "Planning agent - creates detailed work plans",
		tools: ["read", "bash", "subagent"],
		prompt: `You are PROMETHEUS, the planning agent.

Your job: Transform vague requests into detailed, actionable work plans through interactive conversation.

## PHASE 1: INTERVIEW MODE

Begin EVERY planning session with discovery. Launch parallel subagents to gather context:
- subagent(agent: "explore", task: "Find similar implementations in codebase")
- subagent(agent: "librarian", task: "Find official docs and best practices")

Then ask specific questions about deliverables, scope boundaries, and acceptance criteria.

## PHASE 2: METIS CONSULTATION

Before generating the plan, consult Metis:
- subagent(agent: "metis", task: "Review this planning session. What did we miss?")

## PHASE 3: PLAN GENERATION

When user says "Create the plan":
1. Generate markdown plan with: Goal, Requirements, Approach, Files, Acceptance criteria, Risks
2. Save to file if requested
3. Present summary

## CRITICAL RULES

**NEVER:**
- Generate a plan without interviewing first
- Skip Metis consultation
- Write implementation code

**ALWAYS:**
- Use subagents for discovery (explore, librarian, metis)
- Ask specific questions with context
- Include agent-executable acceptance criteria
- Get user confirmation before finalizing`,
	},
};

// Simple YAML-like parser for frontmatter (supports basic key: value and lists)
function parseSimpleYaml(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split('\n');
	let currentKey: string | null = null;
	let currentList: string[] = [];
	let inList = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		// Check for list item
		if (trimmed.startsWith('- ')) {
			if (inList && currentKey) {
				currentList.push(trimmed.slice(2).trim());
			}
			continue;
		}

		// If we were in a list, save it
		if (inList && currentKey) {
			result[currentKey] = currentList;
			currentList = [];
			inList = false;
		}

		// Parse key: value
		const match = trimmed.match(/^([^:]+):\s*(.*)$/);
		if (match) {
			const [, key, value] = match;
			currentKey = key.trim();
			const trimmedValue = value.trim();

			if (trimmedValue === '') {
				// Empty value might be start of list
				inList = true;
				currentList = [];
			} else if (trimmedValue.startsWith('[') && trimmedValue.endsWith(']')) {
				// Inline array: ["a", "b"]
				try {
					result[currentKey] = JSON.parse(trimmedValue.replace(/'/g, '"'));
				} catch {
					result[currentKey] = trimmedValue.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
				}
				currentKey = null;
			} else if (!isNaN(Number(trimmedValue))) {
				result[currentKey] = Number(trimmedValue);
				currentKey = null;
			} else if (trimmedValue === 'true' || trimmedValue === 'false') {
				result[currentKey] = trimmedValue === 'true';
				currentKey = null;
			} else {
				result[currentKey] = trimmedValue.replace(/^["']|["']$/g, '');
				currentKey = null;
			}
		}
	}

	// Handle trailing list
	if (inList && currentKey) {
		result[currentKey] = currentList;
	}

	return result;
}

// Parse YAML frontmatter from markdown
function parseModeFile(content: string, filename: string): ModeConfig | null {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) {
		console.error(`[primary-modes] Invalid mode file (no frontmatter): ${filename}`);
		return null;
	}

	try {
		const frontmatter = parseSimpleYaml(match[1]);
		const prompt = match[2].trim();

		if (!frontmatter.name || typeof frontmatter.name !== 'string') {
			console.error(`[primary-modes] Mode file missing 'name': ${filename}`);
			return null;
		}

		return {
			name: frontmatter.name,
			description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
			model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
			tools: Array.isArray(frontmatter.tools) ? frontmatter.tools.filter((t): t is string => typeof t === 'string') : undefined,
			temperature: typeof frontmatter.temperature === 'number' ? frontmatter.temperature : undefined,
			prompt,
		};
	} catch (e) {
		console.error(`[primary-modes] Failed to parse frontmatter in ${filename}:`, e);
		return null;
	}
}

// Load all mode definitions
function loadModes(): Map<string, ModeConfig> {
	const modes = new Map<string, ModeConfig>();

	// Start with builtins
	for (const [key, mode] of Object.entries(BUILTIN_MODES)) {
		modes.set(key, mode);
	}

	// Load from ~/.pi/agent/modes/*.md
	if (existsSync(MODES_DIR)) {
		try {
			const files = readdirSync(MODES_DIR).filter((f) => f.endsWith(".md"));
			for (const file of files) {
				const content = readFileSync(join(MODES_DIR, file), "utf-8");
				const mode = parseModeFile(content, file);
				if (mode) {
					modes.set(mode.name, mode);
				}
			}
		} catch (e) {
			console.error("[primary-modes] Error loading modes:", e);
		}
	}

	return modes;
}

export default function primaryModesExtension(pi: ExtensionAPI): void {
	const modes = loadModes();
	const modeNames = Array.from(modes.keys());

	let activeMode = DEFAULT_MODE;
	let modeSwitchedThisTurn = false; // Track if we just switched (to inject prompt)

	function getMode(name: string): ModeConfig | undefined {
		return modes.get(name);
	}

	function setActiveMode(name: string, ctx: ExtensionContext): boolean {
		const mode = getMode(name);
		if (!mode) {
			ctx.ui.notify(`Unknown mode: ${name}`, "error");
			return false;
		}

		activeMode = name;
		modeSwitchedThisTurn = true;

		// Update tools
		if (mode.tools && mode.tools.length > 0) {
			pi.setActiveTools(mode.tools);
		}

		// Update model if specified
		if (mode.model && ctx.model) {
			const modelRegistry = ctx.modelRegistry;
			const targetModel = modelRegistry.findModel(mode.model);
			if (targetModel) {
				pi.setModel(targetModel).catch((e) => {
					console.error("[primary-modes] Failed to set model:", e);
				});
			}
		}

		// Update status bar
		updateStatus(ctx);

		// Persist state
		pi.appendEntry("primary-mode", {
			activeMode,
			availableModes: modeNames,
		});

		return true;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const mode = getMode(activeMode);
		if (mode) {
			const displayName = mode.name.charAt(0).toUpperCase() + mode.name.slice(1);
			ctx.ui.setStatus("primary-mode", ctx.ui.theme.fg("accent", `🎯 ${displayName}`));
		}
	}

	function cycleMode(ctx: ExtensionContext): void {
		const currentIndex = modeNames.indexOf(activeMode);
		const nextIndex = (currentIndex + 1) % modeNames.length;
		const nextMode = modeNames[nextIndex];

		if (setActiveMode(nextMode, ctx)) {
			const mode = getMode(nextMode)!;
			ctx.ui.notify(`Switched to ${mode.name} mode`, "info");
		}
	}

	// Register /mode command
	pi.registerCommand("mode", {
		description: "Switch to a different agent mode",
		getArgumentCompletions: (prefix: string) => {
			return modeNames
				.filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
				.map((name) => ({
					label: name,
					detail: modes.get(name)?.description || "",
				}));
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const name = args.trim().toLowerCase();
			if (!name) {
				// Show current mode
				const mode = getMode(activeMode);
				ctx.ui.notify(`Current mode: ${activeMode}${mode?.description ? ` - ${mode.description}` : ""}`, "info");
				return;
			}

			if (setActiveMode(name, ctx)) {
				const mode = getMode(name)!;
				ctx.ui.notify(`Switched to ${mode.name} mode`, "info");
				// Trigger a turn to apply the new mode's system prompt
				pi.sendUserMessage("Mode switched. Acknowledge the change.", { deliverAs: "nextTurn" });
			}
		},
	});

	// Register Alt+M shortcut to cycle modes (Ctrl+Tab is intercepted by terminals)
	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle to next agent mode",
		handler: async (ctx: ExtensionContext) => {
			cycleMode(ctx);
		},
	});

	// Register Ctrl+Shift+M shortcut for quick mode switch (FIXED: was Ctrl+M which = Enter)
	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Show mode selector",
		handler: async (ctx: ExtensionContext) => {
			const choice = await ctx.ui.select(
				"Select mode:",
				modeNames.map((name) => {
					const mode = modes.get(name);
					return `${name}${mode?.description ? ` - ${mode.description}` : ""}`;
				}),
			);
			if (choice) {
				const name = choice.split(" - ")[0];
				if (setActiveMode(name, ctx)) {
					ctx.ui.notify(`Switched to ${name} mode`, "info");
					pi.sendUserMessage("Mode switched. Acknowledge the change.", { deliverAs: "nextTurn" });
				}
			}
		},
	});

	// Inject system prompt on before_agent_start
	pi.on("before_agent_start", async (_event) => {
		const mode = getMode(activeMode);
		if (!mode) return;

		// Only inject if we just switched, or always inject mode's prompt
		// For now, inject on every turn to ensure mode's personality is active
		return {
			systemPrompt: mode.prompt,
			message: {
				customType: "primary-mode-context",
				content: `[MODE: ${mode.name.toUpperCase()}]`,
				display: false,
			},
		};
	});

	// Update status bar on turn start
	pi.on("turn_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	// Restore mode on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		// Find last mode entry
		const modeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "primary-mode")
			.pop() as { data?: ModeState } | undefined;

		if (modeEntry?.data?.activeMode) {
			const savedMode = modeEntry.data.activeMode;
			if (modes.has(savedMode)) {
				activeMode = savedMode;
			}
		}

		// Apply the active mode
		setActiveMode(activeMode, ctx);
	});

	// Log on shutdown
	pi.on("session_shutdown", async () => {});
}
