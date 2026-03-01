export interface TestCase {
	/** Unique identifier */
	id: string;
	/** Category: "synthetic" or "real" */
	category: "synthetic" | "real";
	/** Short description of what the edit should do */
	description: string;
	/** The source file content before editing */
	sourceContent: string;
	/** The user prompt telling the LLM what to edit */
	prompt: string;
	/** For synthetic: exact expected content after edit. undefined for real prompts. */
	expectedContent?: string;
	/** For real prompts: patterns (strings or regexes) that must appear in the result */
	expectedPatterns?: (string | RegExp)[];
	/** For real prompts: patterns that must NOT appear in the result */
	forbiddenPatterns?: (string | RegExp)[];
}

export type CaseVerdict = "pass" | "fail" | "error";

export interface TestResult {
	id: string;
	category: "synthetic" | "real";
	description: string;
	verdict: CaseVerdict;
	/** Wall-clock ms for the LLM call */
	latencyMs: number;
	/** Whether autocorrect modified the replacement lines */
	autocorrectTriggered: boolean;
	/** Number of no-op edits detected */
	noopEdits: number;
	/** Number of duplicates removed */
	duplicatesRemoved: number;
	/** Error message if verdict is "error" or "fail" */
	errorMessage?: string;
	/** The raw tool call arguments from the LLM */
	rawToolArgs?: unknown;
	/** The actual content after applying edits */
	actualContent?: string;
}
