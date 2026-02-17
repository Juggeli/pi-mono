/**
 * Hashline-based edit system.
 *
 * Lines are referenced by "LINE:HASH" format (e.g., "5:a3f1c2d4"), where hash
 * is an 8-char hex derived from line number, normalized content, and per-content
 * occurrence index. This strengthens stale-reference detection for duplicate lines.
 */

import { createHash } from "node:crypto";

// ============================================================================
// Constants
// ============================================================================

/** 256 two-character hex strings ("00" through "ff") */
export const HASH_DICT = [
	"00",
	"01",
	"02",
	"03",
	"04",
	"05",
	"06",
	"07",
	"08",
	"09",
	"0a",
	"0b",
	"0c",
	"0d",
	"0e",
	"0f",
	"10",
	"11",
	"12",
	"13",
	"14",
	"15",
	"16",
	"17",
	"18",
	"19",
	"1a",
	"1b",
	"1c",
	"1d",
	"1e",
	"1f",
	"20",
	"21",
	"22",
	"23",
	"24",
	"25",
	"26",
	"27",
	"28",
	"29",
	"2a",
	"2b",
	"2c",
	"2d",
	"2e",
	"2f",
	"30",
	"31",
	"32",
	"33",
	"34",
	"35",
	"36",
	"37",
	"38",
	"39",
	"3a",
	"3b",
	"3c",
	"3d",
	"3e",
	"3f",
	"40",
	"41",
	"42",
	"43",
	"44",
	"45",
	"46",
	"47",
	"48",
	"49",
	"4a",
	"4b",
	"4c",
	"4d",
	"4e",
	"4f",
	"50",
	"51",
	"52",
	"53",
	"54",
	"55",
	"56",
	"57",
	"58",
	"59",
	"5a",
	"5b",
	"5c",
	"5d",
	"5e",
	"5f",
	"60",
	"61",
	"62",
	"63",
	"64",
	"65",
	"66",
	"67",
	"68",
	"69",
	"6a",
	"6b",
	"6c",
	"6d",
	"6e",
	"6f",
	"70",
	"71",
	"72",
	"73",
	"74",
	"75",
	"76",
	"77",
	"78",
	"79",
	"7a",
	"7b",
	"7c",
	"7d",
	"7e",
	"7f",
	"80",
	"81",
	"82",
	"83",
	"84",
	"85",
	"86",
	"87",
	"88",
	"89",
	"8a",
	"8b",
	"8c",
	"8d",
	"8e",
	"8f",
	"90",
	"91",
	"92",
	"93",
	"94",
	"95",
	"96",
	"97",
	"98",
	"99",
	"9a",
	"9b",
	"9c",
	"9d",
	"9e",
	"9f",
	"a0",
	"a1",
	"a2",
	"a3",
	"a4",
	"a5",
	"a6",
	"a7",
	"a8",
	"a9",
	"aa",
	"ab",
	"ac",
	"ad",
	"ae",
	"af",
	"b0",
	"b1",
	"b2",
	"b3",
	"b4",
	"b5",
	"b6",
	"b7",
	"b8",
	"b9",
	"ba",
	"bb",
	"bc",
	"bd",
	"be",
	"bf",
	"c0",
	"c1",
	"c2",
	"c3",
	"c4",
	"c5",
	"c6",
	"c7",
	"c8",
	"c9",
	"ca",
	"cb",
	"cc",
	"cd",
	"ce",
	"cf",
	"d0",
	"d1",
	"d2",
	"d3",
	"d4",
	"d5",
	"d6",
	"d7",
	"d8",
	"d9",
	"da",
	"db",
	"dc",
	"dd",
	"de",
	"df",
	"e0",
	"e1",
	"e2",
	"e3",
	"e4",
	"e5",
	"e6",
	"e7",
	"e8",
	"e9",
	"ea",
	"eb",
	"ec",
	"ed",
	"ee",
	"ef",
	"f0",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"fa",
	"fb",
	"fc",
	"fd",
	"fe",
	"ff",
] as const;

/** Regex to parse hashline-formatted output: "LINE:HASH|content" */
export const HASHLINE_PATTERN = /^(\d+):([0-9a-f]{8})\|(.*)$/;

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

export type HashlineEdit = SetLineEdit | ReplaceLinesEdit | InsertAfterEdit;

// ============================================================================
// Hash Computation
// ============================================================================

function normalizeLineContent(content: string): string {
	return content.replace(/\s+/g, "");
}

function getLineOccurrence(lines: string[], lineNumber: number): number {
	const target = normalizeLineContent(lines[lineNumber - 1]);
	let occurrence = 0;
	for (let i = 0; i < lineNumber; i++) {
		if (normalizeLineContent(lines[i]) === target) {
			occurrence++;
		}
	}
	return occurrence;
}

/** Compute an 8-char hex hash for a line using line number, normalized content, and occurrence index. */
export function computeLineHash(lineNumber: number, content: string, occurrence = 1): string {
	const stripped = normalizeLineContent(content);
	const digest = createHash("md5").update(`${lineNumber}\0${occurrence}\0${stripped}`).digest();
	return `${HASH_DICT[digest[0]]}${digest.toString("hex", 1, 4)}`;
}

/** Format a single line as "LINE:HASH|content" */
export function formatHashLine(lineNumber: number, content: string, occurrence = 1): string {
	const hash = computeLineHash(lineNumber, content, occurrence);
	return `${lineNumber}:${hash}|${content}`;
}

/** Format all lines of content with hashline prefixes. startLine is 1-indexed (default 1). */
export function formatHashLines(content: string, startLine = 1, precedingLines: string[] = []): string {
	const lines = content.split("\n");
	const occurrenceByContent = new Map<string, number>();
	for (const line of precedingLines) {
		const normalized = normalizeLineContent(line);
		occurrenceByContent.set(normalized, (occurrenceByContent.get(normalized) ?? 0) + 1);
	}
	return lines
		.map((line, index) => {
			const normalized = normalizeLineContent(line);
			const occurrence = (occurrenceByContent.get(normalized) ?? 0) + 1;
			occurrenceByContent.set(normalized, occurrence);
			return formatHashLine(startLine + index, line, occurrence);
		})
		.join("\n");
}

// ============================================================================
// Validation
// ============================================================================

/** Parse a "LINE:HASH" reference string into { line, hash } */
export function parseLineRef(ref: string): LineRef {
	const match = ref.match(/^(\d+):([0-9a-f]{8})$/);
	if (!match) {
		throw new Error(`Invalid line reference format: "${ref}". Expected format: "LINE:HASH" (e.g., "42:a3f1c2d4")`);
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
	const occurrence = getLineOccurrence(lines, line);
	const currentHash = computeLineHash(line, content, occurrence);

	if (currentHash !== hash) {
		throw new Error(
			`Hash mismatch at line ${line}. Expected hash: ${hash}, current hash: ${currentHash}. ` +
				`Line content may have changed. Current content: "${content}"`,
		);
	}
}

// ============================================================================
// Edit Operations
// ============================================================================

function unescapeNewlines(text: string): string {
	return text.replace(/\\n/g, "\n");
}

function getEditLineNumber(edit: HashlineEdit): number {
	switch (edit.type) {
		case "set_line":
			return parseLineRef(edit.line).line;
		case "replace_lines":
			return parseLineRef(edit.end_line).line;
		case "insert_after":
			return parseLineRef(edit.line).line;
	}
}

/** Apply hashline edits to content. Sorts edits bottom-up (highest line first) to preserve line references. */
export function applyHashlineEdits(content: string, edits: HashlineEdit[]): string {
	if (edits.length === 0) {
		return content;
	}

	// Sort bottom-up: highest line numbers first
	const sortedEdits = [...edits].sort((a, b) => getEditLineNumber(b) - getEditLineNumber(a));

	const lines = content.split("\n");

	for (const edit of sortedEdits) {
		switch (edit.type) {
			case "set_line": {
				validateLineRef(lines, edit.line);
				const { line } = parseLineRef(edit.line);
				lines[line - 1] = unescapeNewlines(edit.text);
				break;
			}
			case "replace_lines": {
				validateLineRef(lines, edit.start_line);
				validateLineRef(lines, edit.end_line);
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
				validateLineRef(lines, edit.line);
				const { line } = parseLineRef(edit.line);
				const newLines = unescapeNewlines(edit.text).split("\n");
				lines.splice(line, 0, ...newLines);
				break;
			}
		}
	}

	return lines.join("\n");
}
