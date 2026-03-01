/**
 * Hashline edit tool benchmark.
 *
 * Sends coding edit prompts to an LLM with the edit tool definition,
 * then applies the returned edits through our hashline pipeline and
 * checks correctness.
 *
 * Usage:
 *   npx tsx bench/edit-bench.ts [--provider zai] [--model glm-4.7] [--filter syn-01] [--concurrency 4]
 */

import { Type } from "@sinclair/typebox";
import { complete, getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import type { Api, AssistantMessage, Context, KnownProvider, Model, Tool } from "@mariozechner/pi-ai";
import { formatHashLines, applyHashlineEdits, parseLineRef, type HashlineEdit } from "../src/core/tools/hashline.js";
import { normalizeHashlineEdits, type RawHashlineEdit } from "../src/core/tools/normalize-edits.js";
import { dedupeEdits } from "../src/core/tools/edit-deduplication.js";
import { toNewLines } from "../src/core/tools/edit-text-normalization.js";
import { autocorrectReplacementLines } from "../src/core/tools/autocorrect-replacement-lines.js";
import { ALL_CASES } from "./fixtures.js";
import type { TestCase, TestResult, CaseVerdict } from "./types.js";

// ============================================================================
// CLI args
// ============================================================================

function parseArgs(): { provider: KnownProvider; modelId: string; filter?: string; concurrency: number } {
	const args = process.argv.slice(2);
	let provider: KnownProvider = "zai";
	let modelId = "glm-4.7";
	let filter: string | undefined;
	let concurrency = 1;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--provider" && args[i + 1]) {
			provider = args[++i] as KnownProvider;
		} else if (args[i] === "--model" && args[i + 1]) {
			modelId = args[++i];
		} else if (args[i] === "--filter" && args[i + 1]) {
			filter = args[++i];
		} else if (args[i] === "--concurrency" && args[i + 1]) {
			concurrency = Number.parseInt(args[++i], 10);
		}
	}

	return { provider, modelId, filter, concurrency };
}

// ============================================================================
// Tool definition (matches our edit tool schema)
// ============================================================================

const EditOperationSchema = Type.Object({
	op: Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("prepend")], {
		description: 'Operation type: "replace", "append", or "prepend"',
	}),
	pos: Type.Optional(Type.String({ description: 'Line reference in LINE#ID format (e.g., "5#ZP")' })),
	end: Type.Optional(Type.String({ description: "End line reference in LINE#ID format (for range replace)" })),
	lines: Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()], {
		description: "New content: string, string[], or null (for deletion)",
	}),
});

const editToolSchema = Type.Object({
	edits: Type.Array(EditOperationSchema, {
		description: "Array of edit operations to apply",
	}),
});

const editTool: Tool<typeof editToolSchema> = {
	name: "edit",
	description: `Edit a file using LINE#ID format for precise, safe modifications.

WORKFLOW:
1. Read the file content (shown with LINE#ID tags).
2. Pick the smallest operation per logical mutation site.
3. Submit all related operations in one call.
4. Use anchors as "LINE#ID" only (never include trailing "|content").

LINE#ID FORMAT (CRITICAL):
 Each line reference must be in "{line_number}#{hash_id}" format where:
 {line_number}: 1-based line number
 {hash_id}: Two CID letters from the set ZPMQVRWSNKTXJBYH

OPERATION CHOICE:
  replace with pos only -> replace one line at pos
  replace with pos+end -> replace ENTIRE range pos..end as a block
  append with pos anchor -> insert after that anchor
  prepend with pos anchor -> insert before that anchor
  append without anchor -> append at EOF
  prepend without anchor -> prepend at BOF

RULES:
 1. Minimize scope: one logical mutation site per operation.
 2. Preserve formatting: keep indentation, punctuation, line breaks.
 3. No no-ops: replacement content must differ from current content.
 4. Copy LINE#ID tags exactly from the file content shown.
 5. lines must contain plain replacement text only (no LINE#ID prefixes).
 6. CRITICAL: all operations validate against the pre-edit snapshot and apply bottom-up.`,
	parameters: editToolSchema,
};

// ============================================================================
// System prompt
// ============================================================================

const SYSTEM_PROMPT = `You are a precise code editor. You will be shown a file's content with LINE#ID tags on each line.
When asked to make changes, use the "edit" tool to apply your edits.

Each line is shown as: LINE#ID|content
For example: 1#ZP|function hello() {

When referencing lines in edit operations, use only the "LINE#ID" part (e.g., "1#ZP"), never include the "|content" part.

Always use the edit tool. Never respond with just text. Apply ALL requested changes in a single tool call.`;

// ============================================================================
// Core: run a single test case
// ============================================================================

async function runCase(
	tc: TestCase,
	model: Model<Api>,
	apiKey: string,
): Promise<TestResult> {
	const startMs = Date.now();

	const hashlineContent = formatHashLines(tc.sourceContent);

	const userMessage = `Here is the file content:\n\n${hashlineContent}\n\nTask: ${tc.prompt}`;

	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
		tools: [editTool],
	};

	let response: AssistantMessage;
	try {
		response = await complete(model, context, { temperature: 0, apiKey });
	} catch (err: any) {
		return {
			id: tc.id,
			category: tc.category,
			description: tc.description,
			verdict: "error",
			latencyMs: Date.now() - startMs,
			autocorrectTriggered: false,
			noopEdits: 0,
			duplicatesRemoved: 0,
			errorMessage: `LLM call failed: ${err.message}`,
		};
	}

	const latencyMs = Date.now() - startMs;

	// Extract tool call
	const toolCall = response.content.find((b) => b.type === "toolCall" && b.name === "edit");
	if (!toolCall || toolCall.type !== "toolCall") {
		return {
			id: tc.id,
			category: tc.category,
			description: tc.description,
			verdict: "error",
			latencyMs,
			autocorrectTriggered: false,
			noopEdits: 0,
			duplicatesRemoved: 0,
			errorMessage: `LLM did not call the edit tool. Stop reason: ${response.stopReason}. Error: ${response.errorMessage ?? "none"}. Content types: ${response.content.map((b) => b.type).join(", ")}`,
		};
	}

	const rawArgs = toolCall.arguments as { edits?: RawHashlineEdit[] };
	if (!rawArgs.edits || !Array.isArray(rawArgs.edits) || rawArgs.edits.length === 0) {
		return {
			id: tc.id,
			category: tc.category,
			description: tc.description,
			verdict: "error",
			latencyMs,
			autocorrectTriggered: false,
			noopEdits: 0,
			duplicatesRemoved: 0,
			errorMessage: "Tool call has empty or missing edits array",
			rawToolArgs: rawArgs,
		};
	}

	// Normalize and deduplicate
	let normalizedEdits: HashlineEdit[];
	let duplicatesRemoved = 0;
	try {
		normalizedEdits = normalizeHashlineEdits(rawArgs.edits);
		const deduped = dedupeEdits(normalizedEdits);
		normalizedEdits = deduped.edits;
		duplicatesRemoved = deduped.duplicatesRemoved;
	} catch (err: any) {
		return {
			id: tc.id,
			category: tc.category,
			description: tc.description,
			verdict: "error",
			latencyMs,
			autocorrectTriggered: false,
			noopEdits: 0,
			duplicatesRemoved: 0,
			errorMessage: `Edit normalization failed: ${err.message}`,
			rawToolArgs: rawArgs,
		};
	}

	// Apply edits
	let resultContent: string;
	let noopEdits: number;
	try {
		const report = applyHashlineEdits(tc.sourceContent, normalizedEdits);
		resultContent = report.content;
		noopEdits = report.noopEdits;
	} catch (err: any) {
		return {
			id: tc.id,
			category: tc.category,
			description: tc.description,
			verdict: "error",
			latencyMs,
			autocorrectTriggered: false,
			noopEdits: 0,
			duplicatesRemoved,
			errorMessage: `Edit apply failed: ${err.message}`,
			rawToolArgs: rawArgs,
		};
	}

	// Detect autocorrect: re-apply without autocorrect by checking if raw lines differ from corrected
	const autocorrectTriggered = detectAutocorrect(tc.sourceContent, normalizedEdits);

	// Verify result
	let verdict: CaseVerdict;
	let errorMessage: string | undefined;

	if (tc.category === "synthetic" && tc.expectedContent !== undefined) {
		if (normalizeWhitespace(resultContent) === normalizeWhitespace(tc.expectedContent)) {
			verdict = "pass";
		} else {
			verdict = "fail";
			errorMessage = buildDiffMessage(tc.expectedContent, resultContent);
		}
	} else if (tc.category === "real") {
		const patternResult = checkPatterns(resultContent, tc.expectedPatterns, tc.forbiddenPatterns);
		if (patternResult === null) {
			verdict = "pass";
		} else {
			verdict = "fail";
			errorMessage = patternResult;
		}
	} else {
		verdict = "pass";
	}

	return {
		id: tc.id,
		category: tc.category,
		description: tc.description,
		verdict,
		latencyMs,
		autocorrectTriggered,
		noopEdits,
		duplicatesRemoved,
		errorMessage,
		rawToolArgs: rawArgs,
		actualContent: resultContent,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeWhitespace(s: string): string {
	return s
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function buildDiffMessage(expected: string, actual: string): string {
	const expLines = expected.split("\n");
	const actLines = actual.split("\n");
	const lines: string[] = [];
	const maxLines = Math.max(expLines.length, actLines.length);

	for (let i = 0; i < maxLines; i++) {
		const exp = expLines[i] ?? "<missing>";
		const act = actLines[i] ?? "<missing>";
		if (exp.trimEnd() !== act.trimEnd()) {
			lines.push(`  Line ${i + 1}:`);
			lines.push(`    expected: ${JSON.stringify(exp)}`);
			lines.push(`    actual:   ${JSON.stringify(act)}`);
		}
	}

	if (lines.length === 0) {
		return "Content differs but no line-level diff found (possibly trailing whitespace)";
	}
	return `Content mismatch:\n${lines.slice(0, 30).join("\n")}`;
}

function checkPatterns(
	content: string,
	expectedPatterns?: (string | RegExp)[],
	forbiddenPatterns?: (string | RegExp)[],
): string | null {
	if (expectedPatterns) {
		for (const pattern of expectedPatterns) {
			if (typeof pattern === "string") {
				if (!content.includes(pattern)) {
					return `Missing expected pattern: ${JSON.stringify(pattern)}`;
				}
			} else {
				if (!pattern.test(content)) {
					return `Missing expected pattern: ${pattern.toString()}`;
				}
			}
		}
	}

	if (forbiddenPatterns) {
		for (const pattern of forbiddenPatterns) {
			if (typeof pattern === "string") {
				if (content.includes(pattern)) {
					return `Found forbidden pattern: ${JSON.stringify(pattern)}`;
				}
			} else {
				if (pattern.test(content)) {
					return `Found forbidden pattern: ${pattern.toString()}`;
				}
			}
		}
	}

	return null;
}

/**
 * Detect whether autocorrect modified any replacement lines.
 * We do this by comparing the raw toNewLines() output against
 * what autocorrectReplacementLines() produces for each edit.
 */
function detectAutocorrect(sourceContent: string, edits: HashlineEdit[]): boolean {
	const lines = sourceContent.split("\n");

	for (const edit of edits) {
		if (edit.op === "replace") {
			const rawNewLines = toNewLines(edit.lines);
			let originalRange: string[];
			if (edit.end) {
				const startLine = parseLineRef(edit.pos).line;
				const endLine = parseLineRef(edit.end).line;
				originalRange = lines.slice(startLine - 1, endLine);
			} else {
				const line = parseLineRef(edit.pos).line;
				originalRange = [lines[line - 1] ?? ""];
			}
			const corrected = autocorrectReplacementLines(originalRange, rawNewLines);
			if (corrected.join("\n") !== rawNewLines.join("\n")) {
				return true;
			}
		}
	}
	return false;
}

// ============================================================================
// Runner with concurrency
// ============================================================================

async function runWithConcurrency(
	cases: TestCase[],
	model: Model<Api>,
	apiKey: string,
	concurrency: number,
): Promise<TestResult[]> {
	const results: TestResult[] = [];
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < cases.length) {
			const idx = nextIndex++;
			const tc = cases[idx];
			process.stdout.write(`  [${idx + 1}/${cases.length}] ${tc.id} ... `);
			const result = await runCase(tc, model, apiKey);
			results.push(result);

			const icon = result.verdict === "pass" ? "OK" : result.verdict === "fail" ? "FAIL" : "ERR";
			const extra: string[] = [];
			if (result.autocorrectTriggered) extra.push("autocorrect");
			if (result.noopEdits > 0) extra.push(`${result.noopEdits} noop`);
			if (result.duplicatesRemoved > 0) extra.push(`${result.duplicatesRemoved} dedup`);
			const suffix = extra.length > 0 ? ` (${extra.join(", ")})` : "";
			console.log(`${icon} ${result.latencyMs}ms${suffix}`);

			if (result.verdict !== "pass" && result.errorMessage) {
				console.log(`    ${result.errorMessage.split("\n")[0]}`);
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, cases.length) }, () => worker());
	await Promise.all(workers);

	// Sort by original order
	const caseOrder = new Map(cases.map((c, i) => [c.id, i]));
	results.sort((a, b) => (caseOrder.get(a.id) ?? 0) - (caseOrder.get(b.id) ?? 0));
	return results;
}

// ============================================================================
// Reporting
// ============================================================================

function printSummary(results: TestResult[]): void {
	const synResults = results.filter((r) => r.category === "synthetic");
	const realResults = results.filter((r) => r.category === "real");

	function stats(rs: TestResult[]) {
		const pass = rs.filter((r) => r.verdict === "pass").length;
		const fail = rs.filter((r) => r.verdict === "fail").length;
		const err = rs.filter((r) => r.verdict === "error").length;
		const autocorrect = rs.filter((r) => r.autocorrectTriggered).length;
		const avgLatency = rs.length > 0 ? Math.round(rs.reduce((a, r) => a + r.latencyMs, 0) / rs.length) : 0;
		return { total: rs.length, pass, fail, err, autocorrect, avgLatency };
	}

	const synStats = stats(synResults);
	const realStats = stats(realResults);
	const allStats = stats(results);

	console.log("\n" + "=".repeat(70));
	console.log("BENCHMARK RESULTS");
	console.log("=".repeat(70));

	const row = (label: string, s: ReturnType<typeof stats>) =>
		`  ${label.padEnd(12)} ${String(s.pass).padStart(4)} pass | ${String(s.fail).padStart(4)} fail | ${String(s.err).padStart(4)} err | ${String(s.autocorrect).padStart(4)} autocorrect | ${String(s.avgLatency).padStart(6)}ms avg`;

	console.log(row("Synthetic", synStats));
	console.log(row("Real", realStats));
	console.log("-".repeat(70));
	console.log(row("Total", allStats));
	console.log("=".repeat(70));

	// Accuracy
	const accuracy = allStats.total > 0 ? ((allStats.pass / allStats.total) * 100).toFixed(1) : "N/A";
	const autocorrectRate = allStats.total > 0 ? ((allStats.autocorrect / allStats.total) * 100).toFixed(1) : "N/A";
	console.log(`\n  Accuracy: ${accuracy}%`);
	console.log(`  Autocorrect rate: ${autocorrectRate}%`);

	// Failed/errored cases detail
	const failures = results.filter((r) => r.verdict !== "pass");
	if (failures.length > 0) {
		console.log("\n" + "-".repeat(70));
		console.log("FAILURES:");
		for (const f of failures) {
			console.log(`\n  [${f.verdict.toUpperCase()}] ${f.id}: ${f.description}`);
			if (f.errorMessage) {
				for (const line of f.errorMessage.split("\n").slice(0, 10)) {
					console.log(`    ${line}`);
				}
			}
		}
	}
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
	const { provider, modelId, filter, concurrency } = parseArgs();

	const apiKey = getEnvApiKey(provider);
	if (!apiKey) {
		console.error(`No API key found for provider "${provider}". Set the appropriate env var (e.g., ZAI_API_KEY).`);
		process.exit(1);
	}

	const model = getModel(provider, modelId as any);
	if (!model) {
		console.error(`Model not found: ${provider}/${modelId}`);
		process.exit(1);
	}

	console.log(`Hashline Edit Benchmark`);
	console.log(`  Provider: ${provider}`);
	console.log(`  Model: ${modelId}`);
	console.log(`  Concurrency: ${concurrency}`);

	let cases = ALL_CASES;
	if (filter) {
		cases = cases.filter((c) => c.id.includes(filter) || c.category === filter || c.description.toLowerCase().includes(filter.toLowerCase()));
		console.log(`  Filter: "${filter}" (${cases.length} cases)`);
	}

	if (cases.length === 0) {
		console.log("No test cases match the filter.");
		process.exit(1);
	}

	console.log(`  Total cases: ${cases.length}\n`);

	const results = await runWithConcurrency(cases, model, apiKey, concurrency);
	printSummary(results);

	// Exit with non-zero if any failures
	const failures = results.filter((r) => r.verdict !== "pass");
	if (failures.length > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(2);
});
