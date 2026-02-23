# Subagent System Reference

Reference documentation for the pi-mono subagent extension, including a comparison with oh-my-opencode's agent system and a roadmap for new agents.

---

## Current Agents (pi-mono)

### Primary Agents (use user's UI-selected model)

| Agent | Description | Tools Blocked | Can Spawn Subagents |
|---|---|---|---|
| **sisyphus** | Main orchestrator. Parses implicit requirements, delegates to subagents, creates todo lists, verifies results. | None | Yes |
| **prometheus** | Planning agent. Interviews user, explores codebase, generates detailed work plans. Never writes code. | `write`, `edit` | Yes (explore for research) |

### Subagents (own model, ignore UI selection)

| Agent | Description | Model | Tools Blocked | Extensions |
|---|---|---|---|---|
| **explore** | Read-only codebase search. Finds files, patterns, architecture. Parallel-first execution. | MiniMax-M2.1 | `write`, `edit`, `subagent` | No |
| **librarian** | External library research. Finds docs, source code, usage examples via web search, GitHub CLI. | MiniMax-M2.1 | `write`, `edit`, `subagent` | Yes (exa_search, grep_code_search) |
| **review** | Code review specialist. Analyzes for bugs, security, style, performance. | (default) | `write`, `edit`, `subagent` | No |

### Mode Reference

| Mode | Meaning |
|---|---|
| `primary` | Shown in mode switcher. Uses user's UI-selected model. |
| `subagent` | Only spawnable by other agents. Uses own model. |
| `all` | Available in both contexts. |

### Tool Restriction Profiles

```
SUBAGENT_DEFAULTS       = { subagent: false }
EXPLORE_RESTRICTIONS    = { subagent: false, write: false, edit: false }
REVIEW_RESTRICTIONS     = { subagent: false, write: false, edit: false }
LIBRARIAN_RESTRICTIONS  = { subagent: false, write: false, edit: false }
PROMETHEUS_RESTRICTIONS = { write: false, edit: false }  // keeps subagent access
```

### Available Built-in Tools

| Tool | Description |
|---|---|
| `read` | Read file contents (with offset/limit for large files) |
| `bash` | Execute shell commands |
| `edit` | Edit files (search-and-replace) |
| `write` | Create/overwrite files |
| `grep` | Search file contents with regex |
| `find` | Find files by name/pattern |
| `ls` | List directory contents |
| `subagent` | Spawn child agents (the extension tool itself) |

Extension tools (available when `loadExtensions: true`):
- `exa_search` — Web search
- `exa_contents` — Fetch URL contents
- `grep_code_search` — Search code across public GitHub repos

### Current Dependency Graph

```
sisyphus
├── explore (background search)
└── librarian (background research)

prometheus
└── explore (codebase discovery)

review, explore, librarian
└── (leaf nodes, no spawning)
```

---

## oh-my-opencode Agent System

### Full Agent Roster (11 agents)

#### Primary Agents

| Agent | Description | Tools Blocked | Spawns |
|---|---|---|---|
| **Sisyphus** | Main orchestrator. Plans with todos, assesses complexity, delegates via category+skills. | None (denies `call_omo_agent` via permission) | Explore, Librarian, Oracle (background); Sisyphus-Junior (category) |
| **Hephaestus** | Autonomous deep worker. Explores 2-5x in parallel before acting. Completes tasks end-to-end. | None (denies `call_omo_agent` via permission) | Explore (2-5 parallel), Librarian, Oracle; Sisyphus-Junior (category) |
| **Atlas** | Todo-list orchestrator. Drives a todo list to 100% by delegating each task. | `task`, `call_omo_agent` | Sisyphus-Junior (category), any subagent_type |

#### Subagents

| Agent | Description | Tools Blocked | Cost | Temp |
|---|---|---|---|---|
| **Oracle** | High-IQ reasoning for debugging hard problems and architecture decisions. Read-only. | `write`, `edit`, `task` | Expensive | 0.1 |
| **Explore** | Contextual codebase grep. "Where is X?", "Find code that does Y". | `write`, `edit`, `task`, `call_omo_agent` | Free | 0.1 |
| **Librarian** | External docs/code research via GitHub CLI and web search. | `write`, `edit`, `task`, `call_omo_agent` | Cheap | 0.1 |
| **Metis** | Pre-planning consultant. Finds hidden intentions, ambiguities, AI failure points. | `write`, `edit`, `task` | Expensive | 0.3 |
| **Momus** | Plan reviewer. Evaluates clarity, verifiability, completeness of work plans. | `write`, `edit`, `task` | Expensive | 0.1 |
| **Multimodal-Looker** | PDF/image/diagram analysis. Allowlist: only `read`. | All except `read` | Cheap | 0.1 |

#### Mid-tier Executor

| Agent | Description | Tools Blocked | Spawns |
|---|---|---|---|
| **Sisyphus-Junior** | Focused task executor. Does the grunt work for primaries. | `task` | Explore, Librarian (via `call_omo_agent`) |

#### Internal Framework (not spawnable)

| Agent | Description |
|---|---|
| **Prometheus** | Prompt framework for plan generation. Modular sections assembled by Metis. |

### oh-my-opencode Dependency Graph

```
Sisyphus
├── Explore (background)
├── Librarian (background)
├── Oracle (background)
└── Sisyphus-Junior (category delegation)
    ├── Explore (via call_omo_agent)
    └── Librarian (via call_omo_agent)

Hephaestus
├── Explore (2-5 parallel background)
├── Librarian (background)
├── Oracle (consultation)
└── Sisyphus-Junior (category delegation)

Atlas
├── Sisyphus-Junior (per-task delegation)
└── Any subagent_type (direct)

Metis
└── Oracle (recommended for architecture)

Momus, Oracle, Explore, Librarian
└── (leaf nodes)
```

### Model Configuration Patterns

| Context | Config |
|---|---|
| Claude models on expensive agents | `thinking: { type: "enabled", budgetTokens: 32000 }` |
| GPT models | `reasoningEffort: "medium"`, sometimes `textVerbosity: "high"` |
| Sisyphus-Junior default | `anthropic/claude-sonnet-4-5` |
| Cheap agents (Explore, Librarian) | Cheapest available model |

---

## Roadmap: Agents to Add

### Priority 1: Oracle (reasoning consultant)

**What it does**: Read-only deep reasoning agent for hard debugging, architecture decisions, and second opinions. The primary agent fires Oracle in the background and collects its analysis before making final decisions.

**Why**: The biggest gap in the current system. When Sisyphus hits a hard problem (race condition, architecture tradeoff, subtle bug), it currently has to reason through it alone. Oracle provides a dedicated high-IQ consultation path with an expensive model and extended thinking.

**Implementation**:
- New file: `agents/oracle.ts`
- Mode: `subagent`
- Tools blocked: `write`, `edit`, `subagent` (read-only)
- Temperature: 0.1
- Model: user's selected model or expensive default (opus-class)
- Prompt focus: "You are a reasoning specialist. Analyze the problem, enumerate hypotheses, evaluate evidence, and give a recommendation. Never write code."
- Update code agent prompt to delegate hard problems to Oracle via background task

### Priority 2: Sisyphus-Junior (focused executor)

**What it does**: A lighter version of the sisyphus agent that executes a single well-defined task. Cannot spawn further tasks (prevents delegation chains), but can call explore/librarian for context.

**Why**: When the sisyphus agent breaks work into a todo list, each item is currently executed by the sisyphus agent itself sequentially. With Sisyphus-Junior, the sisyphus agent can delegate items to focused executors, potentially in parallel. This also prevents the primary agent's context from growing unbounded.

**Implementation**:
- New file: `agents/sisyphus-junior.ts`
- Mode: `all` (spawnable by primaries and usable as a primary itself)
- Tools blocked: `subagent: false` replaced with selective access — block `subagent` but add a lightweight `call_agent` that only allows explore/librarian
- Alternative simpler approach: just block `subagent` entirely and rely on the junior doing its own grep/read
- Model: sonnet-class (cheaper than primary)
- Temperature: 0.1
- Prompt: stripped-down Sisyphus without delegation rules

### Priority 3: Metis (pre-planning consultant)

**What it does**: Analyzes a request before planning begins to surface hidden requirements, ambiguities, and likely failure points. Feeds into Prometheus.

**Why**: Prometheus currently jumps straight into interview mode. Metis acts as a pre-filter that catches what the user didn't say — edge cases, implicit dependencies, scope creep risks. Particularly valuable for complex features.

**Implementation**:
- New file: `agents/metis.ts`
- Mode: `subagent`
- Tools blocked: `write`, `edit`, `subagent`
- Temperature: 0.3 (slightly creative for finding blind spots)
- Model: expensive (opus-class, with thinking enabled)
- Prompt focus: "Analyze this request. What is the user NOT saying? What ambiguities exist? What will the AI get wrong? Output a structured risk assessment."
- Update prometheus agent to optionally fire Metis before interviewing

### Priority 4: Momus (plan reviewer)

**What it does**: Reviews work plans for clarity, verifiability, and completeness. Catches vague steps, missing acceptance criteria, and unrealistic assumptions.

**Why**: Plans generated by Prometheus are currently not validated. Momus provides a second pass that ensures the plan is actually executable by an agent — no hand-waving, no "and then integrate everything" steps.

**Implementation**:
- New file: `agents/momus.ts`
- Mode: `subagent`
- Tools blocked: `write`, `edit`, `subagent`
- Temperature: 0.1
- Model: expensive (opus-class, with thinking enabled)
- Prompt focus: "Review this plan. Score each step on clarity (1-5), verifiability (1-5), completeness (1-5). Flag any step below 3. Suggest concrete fixes."

### Priority 5: Atlas (todo-list orchestrator)

**What it does**: Takes a todo list and drives it to completion by delegating each item to Sisyphus-Junior. Tracks progress, handles failures, reorders based on dependencies.

**Why**: Currently the sisyphus agent both plans and executes. Atlas separates orchestration from execution — it never writes code itself, it just dispatches and monitors. Useful for large multi-file tasks.

**Implementation**:
- New file: `agents/atlas.ts`
- Mode: `primary`
- Tools blocked: block `subagent` direct use; provide a structured delegation tool instead
- Temperature: 0.1
- Requires: Sisyphus-Junior exists first
- Prompt focus: "You orchestrate. Read the todo list. For each item, delegate to a focused executor. Track completion. Report progress. Never write code yourself."

### Priority 6: Hephaestus (autonomous deep worker)

**What it does**: Alternative primary mode that explores massively before acting. Fires 2-5 explore agents in parallel, reads the results, then executes with full context. Better for unfamiliar codebases or large refactors.

**Why**: Sisyphus is reactive — it explores as needed. Hephaestus is proactive — it builds a mental model first. Different tool for different jobs. Best for "I don't know this codebase, figure it out and fix X."

**Implementation**:
- New file: `agents/hephaestus.ts`
- Mode: `primary`
- Tools: all (unrestricted, like code agent)
- Model: expensive with thinking enabled
- Prompt focus: "Before ANY action, launch 2-5 explore agents in parallel to map the relevant code. Read ALL results. Only then start implementing."
- Requires: background task execution working well

---

## Architecture Notes

### Key Patterns from oh-my-opencode Worth Adopting

1. **Background-first delegation**: Primary agents fire explore/librarian/oracle in background immediately, collect results later. Never block on research.

2. **Cost tiers**: Agents tagged as FREE/CHEAP/EXPENSIVE. Cheap models for search, expensive for reasoning. Prevents burning tokens on grep.

3. **Category+skills delegation**: Instead of spawning a named agent, specify a domain category and required skills. The system routes to the right executor. More flexible than hardcoded agent names.

4. **Fork-bomb prevention**: Multiple layers — env var check, blocked tools, mode restrictions. Essential when agents can spawn agents.

5. **Session resumability**: Every task returns a session ID. Follow-up questions go to the same session with full context preserved. Already implemented in pi-mono.

### What pi-mono Already Has That oh-my-opencode Also Has

- Subagent spawning with tool restrictions
- Background task management with status tracking
- Per-model concurrency limiting (semaphore)
- Session persistence and resumption
- Extension loading for child agents
- Mode switching (primary agent selection)
- Parallel and chain execution modes
