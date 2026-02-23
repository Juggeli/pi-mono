/**
 * Hashline-based edit system.
 *
 * Lines are referenced by "LINE#ID" format (e.g., "5#ZP"), where ID is a 2-char
 * code from a nibble alphabet. Significance-aware seeding ensures meaningful lines
 * (containing letters/numbers) get position-independent hashes, while punctuation-only
 * lines are seeded with their line number for disambiguation.
 */

import { createHash } from "node:crypto";

// ============================================================================
// Constants
// ============================================================================

const HASHLINE_ALPHABET = "ZPMQVRWSNKTXJBYH";

/** 256 two-character strings from the nibble alphabet */
export const HASHLINE_DICT: readonly string[] = (() => {
	const dict: string[] = [];
	for (let hi = 0; hi < 16; hi++) {
		for (let lo = 0; lo < 16; lo++) {
			dict.push(HASHLINE_ALPHABET[hi] + HASHLINE_ALPHABET[lo]);
		}
	}
	return dict;
})();

/** @deprecated Use HASHLINE_DICT instead */
export const HASH_DICT = HASHLINE_DICT;

/** Regex to parse hashline-formatted output: "LINE#ID:content" */
export const HASHLINE_PATTERN = /^(\d+)#([ZPMQVRWSNKTXJBYH]{2}):(.*)$/;

/** Regex to parse a line reference: "LINE#ID" */
export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;

// ============================================================================
// Types
// ============================================================================

export interface LineRef {
	line: number;
	hash: string;
}

export interface SetLineEdit {
	type: "set_line";
	line: string;
	text: string;
}

export interface ReplaceLinesEdit {
	type: "replace_lines";
	start_line: string;
	end_line: string;
	text: string;
}

export interface InsertAfterEdit {
	type: "insert_after";
	line: string;
	text: string;
}

export interface InsertBeforeEdit {
	type: "insert_before";
	line: string;
	text: string;
}

export interface InsertBetweenEdit {
	type: "insert_between";
	after_line: string;
	before_line: string;
	text: string;
}

export interface ReplaceEdit {
	type: "replace";
	start_line: string;
	end_line: string;
	text: string;
}

export interface AppendEdit {
	type: "append";
	text: string;
}

export interface PrependEdit {
	type: "prepend";
	text: string;
}

export type HashlineEdit =
	| SetLineEdit
	| ReplaceLinesEdit
	| InsertAfterEdit
	| InsertBeforeEdit
	| InsertBetweenEdit
	| ReplaceEdit
	| AppendEdit
	| PrependEdit;

// ============================================================================
// Hash Computation
// ============================================================================

function normalizeLineContent(content: string): string {
	return content.replace(/\s+/g, "");
}

/** Whether content has "significant" characters (letters or numbers) */
function hasSignificantContent(stripped: string): boolean {
	return /[\p{L}\p{N}]/u.test(stripped);
}

/** Compute a 2-char hash ID for a line using significance-aware seeding. */
export function computeLineHash(lineNumber: number, content: string): string {
	const stripped = normalizeLineContent(content);
	// Significant content (letters/digits): seed=0 (position-independent)
	// Punctuation-only or empty: seed=lineNumber (position-dependent)
	const seed = hasSignificantContent(stripped) ? 0 : lineNumber;
	const index = createHash("md5").update(`${seed}\0${stripped}`).digest().readUInt32LE(0) % 256;
	return HASHLINE_DICT[index];
}

/** Format a single line as "LINE#ID:content" */
export function formatHashLine(lineNumber: number, content: string): string {
	const hash = computeLineHash(lineNumber, content);
	return `${lineNumber}#${hash}:${content}`;
}

/** Format all lines of content with hashline prefixes. startLine is 1-indexed (default 1). */
export function formatHashLines(content: string, startLine = 1): string {
	const lines = content.split("\n");
	return lines.map((line, index) => formatHashLine(startLine + index, line)).join("\n");
}

// ============================================================================
// Validation
// ============================================================================

/** Parse a "LINE#ID" reference string into { line, hash } */
export function parseLineRef(ref: string): LineRef {
	const match = ref.match(HASHLINE_REF_PATTERN);
	if (!match) {
		throw new Error(`Invalid line reference format: "${ref}". Expected format: "LINE#ID" (e.g., "42#ZP")`);
	}
	return {
		line: Number.parseInt(match[1], 10),
		hash: match[2],
	};
}

/** Validate that a line reference points to a valid line with matching hash */
export function validateLineRef(lines: string[], ref: string): void {
	const { line, hash } = parseLineRef(ref);

	if (line < 1 || line > lines.length) {
		throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`);
	}

	const content = lines[line - 1];
	const currentHash = computeLineHash(line, content);

	if (currentHash !== hash) {
		throw new Error(
			`Hash mismatch at line ${line}. Expected hash: ${hash}, current hash: ${currentHash}. ` +
				`Line content may have changed. Current content: "${content}". ` +
				`Corrected ref: ${line}#${currentHash}`,
		);
	}
}

export interface HashlineMismatch {
	ref: string;
	line: number;
	expectedHash: string;
	currentHash: string;
	content: string;
}

/**
 * Validate multiple line references in batch.
 * Returns all mismatches at once for better error reporting.
 */
export function validateLineRefs(lines: string[], refs: string[]): void {
	const mismatches: HashlineMismatch[] = [];

	for (const ref of refs) {
		const { line, hash } = parseLineRef(ref);

		if (line < 1 || line > lines.length) {
			throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`);
		}

		const content = lines[line - 1];
		const currentHash = computeLineHash(line, content);

		if (currentHash !== hash) {
			mismatches.push({ ref, line, expectedHash: hash, currentHash, content });
		}
	}

	if (mismatches.length > 0) {
		const details = mismatches
			.map(
				(m) =>
					`  Line ${m.line}: expected ${m.expectedHash}, got ${m.currentHash}. ` +
					`Content: "${m.content}". Corrected: ${m.line}#${m.currentHash}`,
			)
			.join("\n");
		throw new Error(`Hash mismatch for ${mismatches.length} line(s). Re-read the file for updated refs.\n${details}`);
	}
}

// ============================================================================
// Edit Operations
// ============================================================================

function unescapeNewlines(text: string): string {
	return text.replace(/\\n/g, "\n");
}

/** Extract the primary sort key (line number) for bottom-up ordering */
export function getEditLineNumber(edit: HashlineEdit): number {
	switch (edit.type) {
		case "set_line":
			return parseLineRef(edit.line).line;
		case "replace_lines":
			return parseLineRef(edit.end_line).line;
		case "replace":
			return parseLineRef(edit.end_line).line;
		case "insert_after":
			return parseLineRef(edit.line).line;
		case "insert_before":
			return parseLineRef(edit.line).line;
		case "insert_between":
			return parseLineRef(edit.before_line).line;
		case "append":
			return Number.MAX_SAFE_INTEGER;
		case "prepend":
			return 0;
	}
}

/** Collect all line references from edits for batch validation */
export function collectLineRefs(edits: HashlineEdit[]): string[] {
	const refs: string[] = [];
	for (const edit of edits) {
		switch (edit.type) {
			case "set_line":
				refs.push(edit.line);
				break;
			case "replace_lines":
				refs.push(edit.start_line, edit.end_line);
				break;
			case "replace":
				refs.push(edit.start_line, edit.end_line);
				break;
			case "insert_after":
				refs.push(edit.line);
				break;
			case "insert_before":
				refs.push(edit.line);
				break;
			case "insert_between":
				refs.push(edit.after_line, edit.before_line);
				break;
			case "append":
			case "prepend":
				// No line refs to validate
				break;
		}
	}
	return refs;
}

/** Apply hashline edits to content. Sorts edits bottom-up (highest line first) to preserve line references. */
export function applyHashlineEdits(content: string, edits: HashlineEdit[]): string {
	if (edits.length === 0) {
		return content;
	}

	const lines = content.split("\n");

	// Batch validate all line refs upfront
	const refs = collectLineRefs(edits);
	if (refs.length > 0) {
		validateLineRefs(lines, refs);
	}

	// Sort bottom-up: highest line numbers first
	const sortedEdits = [...edits].sort((a, b) => getEditLineNumber(b) - getEditLineNumber(a));

	for (const edit of sortedEdits) {
		switch (edit.type) {
			case "set_line": {
				const { line } = parseLineRef(edit.line);
				lines[line - 1] = unescapeNewlines(edit.text);
				break;
			}
			case "replace_lines": {
				const { line: startLine } = parseLineRef(edit.start_line);
				const { line: endLine } = parseLineRef(edit.end_line);
				if (startLine > endLine) {
					throw new Error(`Invalid range: start line ${startLine} cannot be greater than end line ${endLine}`);
				}
				const unescapedText = unescapeNewlines(edit.text);
				const newLines = unescapedText === "" ? [] : unescapedText.split("\n");
				lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
				break;
			}
			case "replace": {
				const { line: startLine } = parseLineRef(edit.start_line);
				const { line: endLine } = parseLineRef(edit.end_line);
				if (startLine > endLine) {
					throw new Error(`Invalid range: start line ${startLine} cannot be greater than end line ${endLine}`);
				}
				const unescapedText = unescapeNewlines(edit.text);
				const newLines = unescapedText === "" ? [] : unescapedText.split("\n");
				lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
				break;
			}
			case "insert_after": {
				const { line } = parseLineRef(edit.line);
				const newLines = unescapeNewlines(edit.text).split("\n");
				lines.splice(line, 0, ...newLines);
				break;
			}
			case "insert_before": {
				const { line } = parseLineRef(edit.line);
				const newLines = unescapeNewlines(edit.text).split("\n");
				lines.splice(line - 1, 0, ...newLines);
				break;
			}
			case "insert_between": {
				const { line: afterLine } = parseLineRef(edit.after_line);
				const { line: beforeLine } = parseLineRef(edit.before_line);
				if (beforeLine !== afterLine + 1) {
					throw new Error(
						`insert_between requires adjacent lines: after_line ${afterLine} and before_line ${beforeLine} are not adjacent`,
					);
				}
				const newLines = unescapeNewlines(edit.text).split("\n");
				lines.splice(afterLine, 0, ...newLines);
				break;
			}
			case "append": {
				const newLines = unescapeNewlines(edit.text).split("\n");
				lines.push(...newLines);
				break;
			}
			case "prepend": {
				const newLines = unescapeNewlines(edit.text).split("\n");
				lines.unshift(...newLines);
				break;
			}
		}
	}

	return lines.join("\n");
}
