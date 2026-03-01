/**
 * Hashline-based edit system.
 *
 * Lines are referenced by "LINE#ID" format (e.g., "5|ZP"), where ID is a 2-char
 * code from a nibble alphabet. Significance-aware seeding ensures meaningful lines
 * (containing letters/numbers) get position-independent hashes, while punctuation-only
 * lines are seeded with their line number for disambiguation.
 */

import { autocorrectReplacementLines } from "./autocorrect-replacement-lines.js";
import {
	restoreLeadingIndent,
	stripInsertAnchorEcho,
	stripInsertBeforeEcho,
	stripRangeBoundaryEcho,
	toNewLines,
} from "./edit-text-normalization.js";

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

/** Regex to parse hashline-formatted output: "LINE#ID|content" */
export const HASHLINE_PATTERN = /^(\d+)#([ZPMQVRWSNKTXJBYH]{2})\|(.*)$/;

/** Regex to parse a line reference: "LINE#ID" */
export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;

const MISMATCH_CONTEXT = 2;
const LINE_REF_EXTRACT_PATTERN = /([0-9]+#[ZPMQVRWSNKTXJBYH]{2})/;

// ============================================================================
// xxHash32 (pure JS implementation matching Bun.hash.xxHash32)
// ============================================================================

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotl32(x: number, r: number): number {
	return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function mul32(a: number, b: number): number {
	return Math.imul(a, b) >>> 0;
}

function xxHash32(input: Uint8Array, seed: number): number {
	const len = input.length;
	let h32: number;
	let offset = 0;

	if (len >= 16) {
		let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
		let v2 = (seed + PRIME32_2) >>> 0;
		let v3 = (seed + 0) >>> 0;
		let v4 = (seed - PRIME32_1) >>> 0;

		while (offset <= len - 16) {
			const k1 =
				(input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16) | (input[offset + 3] << 24)) >>> 0;
			v1 = mul32(rotl32((v1 + mul32(k1, PRIME32_2)) >>> 0, 13), PRIME32_1) >>> 0;
			offset += 4;

			const k2 =
				(input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16) | (input[offset + 3] << 24)) >>> 0;
			v2 = mul32(rotl32((v2 + mul32(k2, PRIME32_2)) >>> 0, 13), PRIME32_1) >>> 0;
			offset += 4;

			const k3 =
				(input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16) | (input[offset + 3] << 24)) >>> 0;
			v3 = mul32(rotl32((v3 + mul32(k3, PRIME32_2)) >>> 0, 13), PRIME32_1) >>> 0;
			offset += 4;

			const k4 =
				(input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16) | (input[offset + 3] << 24)) >>> 0;
			v4 = mul32(rotl32((v4 + mul32(k4, PRIME32_2)) >>> 0, 13), PRIME32_1) >>> 0;
			offset += 4;
		}

		h32 = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
	} else {
		h32 = (seed + PRIME32_5) >>> 0;
	}

	h32 = (h32 + len) >>> 0;

	while (offset <= len - 4) {
		const k =
			(input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16) | (input[offset + 3] << 24)) >>> 0;
		h32 = mul32(rotl32((h32 + mul32(k, PRIME32_3)) >>> 0, 17), PRIME32_4) >>> 0;
		offset += 4;
	}

	while (offset < len) {
		h32 = mul32(rotl32((h32 + mul32(input[offset], PRIME32_5)) >>> 0, 11), PRIME32_1) >>> 0;
		offset += 1;
	}

	h32 = mul32(h32 ^ (h32 >>> 15), PRIME32_2) >>> 0;
	h32 = mul32(h32 ^ (h32 >>> 13), PRIME32_3) >>> 0;
	h32 = (h32 ^ (h32 >>> 16)) >>> 0;

	return h32;
}

// ============================================================================
// Types
// ============================================================================

export interface LineRef {
	line: number;
	hash: string;
}

export interface ReplaceEdit {
	op: "replace";
	pos: string;
	end?: string;
	lines: string | string[];
}

export interface AppendEdit {
	op: "append";
	pos?: string;
	lines: string | string[];
}

export interface PrependEdit {
	op: "prepend";
	pos?: string;
	lines: string | string[];
}

export type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit;

// ============================================================================
// Hash Computation
// ============================================================================

function normalizeLineContent(content: string): string {
	return content.replace(/\r/g, "").replace(/\s+/g, "");
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
	const data = new TextEncoder().encode(`${seed}\0${stripped}`);
	const hash = xxHash32(data, 0);
	const index = hash % 256;
	return HASHLINE_DICT[index];
}

/** Format a single line as "LINE#ID|content" */
export function formatHashLine(lineNumber: number, content: string): string {
	const hash = computeLineHash(lineNumber, content);
	return `${lineNumber}#${hash}|${content}`;
}

/** Format all lines of content with hashline prefixes. startLine is 1-indexed (default 1). */
export function formatHashLines(content: string, startLine = 1): string {
	const lines = content.split("\n");
	return lines.map((line, index) => formatHashLine(startLine + index, line)).join("\n");
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Normalize flexible line ref input to canonical "LINE#ID".
 * Accepts common copied variants like:
 * - ">>> 42#VK"
 * - "42 # VK"
 * - "42#VK|content"
 */
export function normalizeLineRef(ref: string): string {
	const originalTrimmed = ref.trim();
	let trimmed = originalTrimmed;
	trimmed = trimmed.replace(/^(?:>>>|[+-])\s*/, "");
	trimmed = trimmed.replace(/\s*#\s*/, "#");
	trimmed = trimmed.replace(/\|.*$/, "");
	trimmed = trimmed.trim();

	if (HASHLINE_REF_PATTERN.test(trimmed)) {
		return trimmed;
	}

	const extracted = trimmed.match(LINE_REF_EXTRACT_PATTERN);
	if (extracted) {
		return extracted[1];
	}

	return originalTrimmed;
}

/** Parse a "LINE#ID" reference string into { line, hash } */
export function parseLineRef(ref: string): LineRef {
	const normalized = normalizeLineRef(ref);
	const match = normalized.match(HASHLINE_REF_PATTERN);
	if (match) {
		return {
			line: Number.parseInt(match[1], 10),
			hash: match[2],
		};
	}

	const hashIdx = normalized.indexOf("#");
	if (hashIdx > 0) {
		const prefix = normalized.slice(0, hashIdx);
		const suffix = normalized.slice(hashIdx + 1);
		if (!/^\d+$/.test(prefix) && /^[ZPMQVRWSNKTXJBYH]{2}$/.test(suffix)) {
			throw new Error(
				`Invalid line reference: "${ref}". "${prefix}" is not a line number. ` +
					"Use the actual line number from the read output.",
			);
		}
	}

	throw new Error(`Invalid line reference format: "${ref}". Expected format: "{line_number}#{hash_id}"`);
}

export interface HashlineMismatch {
	line: number;
	expected: string;
}

export class HashlineMismatchError extends Error {
	readonly remaps: ReadonlyMap<string, string>;

	constructor(mismatches: HashlineMismatch[], fileLines: string[]) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";

		const remaps = new Map<string, string>();
		for (const mismatch of mismatches) {
			const actual = computeLineHash(mismatch.line, fileLines[mismatch.line - 1] ?? "");
			remaps.set(`${mismatch.line}#${mismatch.expected}`, `${mismatch.line}#${actual}`);
		}
		this.remaps = remaps;
	}

	static formatMessage(mismatches: HashlineMismatch[], fileLines: string[]): string {
		const mismatchByLine = new Map<number, HashlineMismatch>();
		for (const mismatch of mismatches) mismatchByLine.set(mismatch.line, mismatch);

		const displayLines = new Set<number>();
		for (const mismatch of mismatches) {
			const low = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
			const high = Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT);
			for (let line = low; line <= high; line++) displayLines.add(line);
		}

		const sortedLines = [...displayLines].sort((a, b) => a - b);
		const output: string[] = [];
		output.push(
			`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. ` +
				"Use updated {line_number}#{hash_id} references below (>>> marks changed lines).",
		);
		output.push("");

		let previousLine = -1;
		for (const line of sortedLines) {
			if (previousLine !== -1 && line > previousLine + 1) {
				output.push("    ...");
			}
			previousLine = line;

			const content = fileLines[line - 1] ?? "";
			const hash = computeLineHash(line, content);
			const prefixed = `${line}#${hash}|${content}`;
			output.push(mismatchByLine.has(line) ? `>>> ${prefixed}` : `    ${prefixed}`);
		}

		return output.join("\n");
	}
}

function suggestLineForHash(ref: string, lines: string[]): string | null {
	const hashMatch = ref.trim().match(/#([ZPMQVRWSNKTXJBYH]{2})$/);
	if (!hashMatch) return null;

	const hash = hashMatch[1];
	for (let i = 0; i < lines.length; i++) {
		if (computeLineHash(i + 1, lines[i]) === hash) {
			return `Did you mean "${i + 1}#${hash}"?`;
		}
	}
	return null;
}

function parseLineRefWithHint(ref: string, lines: string[]): LineRef {
	try {
		return parseLineRef(ref);
	} catch (parseError) {
		const hint = suggestLineForHash(ref, lines);
		if (hint && parseError instanceof Error) {
			throw new Error(`${parseError.message} ${hint}`);
		}
		throw parseError;
	}
}

/** Validate that a line reference points to a valid line with matching hash */
export function validateLineRef(lines: string[], ref: string): void {
	const { line, hash } = parseLineRefWithHint(ref, lines);

	if (line < 1 || line > lines.length) {
		throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`);
	}

	const content = lines[line - 1];
	const currentHash = computeLineHash(line, content);

	if (currentHash !== hash) {
		throw new HashlineMismatchError([{ line, expected: hash }], lines);
	}
}

/**
 * Validate multiple line references in batch.
 * Returns all mismatches at once for better error reporting.
 */
export function validateLineRefs(lines: string[], refs: string[]): void {
	const mismatches: HashlineMismatch[] = [];

	for (const ref of refs) {
		const { line, hash } = parseLineRefWithHint(ref, lines);

		if (line < 1 || line > lines.length) {
			throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`);
		}

		const content = lines[line - 1];
		const currentHash = computeLineHash(line, content);
		if (currentHash !== hash) {
			mismatches.push({ line, expected: hash });
		}
	}

	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, lines);
	}
}

// ============================================================================
// Edit Operations
// ============================================================================

/** Extract the primary sort key (line number) for bottom-up ordering */
export function getEditLineNumber(edit: HashlineEdit): number {
	switch (edit.op) {
		case "replace": {
			if (edit.end) return parseLineRef(edit.end).line;
			return parseLineRef(edit.pos).line;
		}
		case "append":
			return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY;
		case "prepend":
			return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY;
	}
}

/** Collect all line references from edits for batch validation */
export function collectLineRefs(edits: HashlineEdit[]): string[] {
	const refs: string[] = [];
	for (const edit of edits) {
		switch (edit.op) {
			case "replace":
				refs.push(edit.pos);
				if (edit.end) refs.push(edit.end);
				break;
			case "append":
				if (edit.pos) refs.push(edit.pos);
				break;
			case "prepend":
				if (edit.pos) refs.push(edit.pos);
				break;
		}
	}
	return refs;
}

/** Detect overlapping replace ranges that would produce ambiguous results. */
export function detectOverlappingRanges(edits: HashlineEdit[]): string | null {
	const ranges: { start: number; end: number; idx: number }[] = [];
	const singleReplaces: { line: number; idx: number }[] = [];

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.op === "replace") {
			if (edit.end) {
				const start = parseLineRef(edit.pos).line;
				const end = parseLineRef(edit.end).line;
				if (start > end) continue;
				ranges.push({ start, end, idx: i });
			} else {
				singleReplaces.push({ line: parseLineRef(edit.pos).line, idx: i });
			}
		}
	}

	if (ranges.length > 1) {
		ranges.sort((a, b) => a.start - b.start || a.end - b.end);
		for (let i = 1; i < ranges.length; i++) {
			const prev = ranges[i - 1];
			const curr = ranges[i];
			if (curr.start <= prev.end) {
				return (
					`Overlapping range edits detected: ` +
					`edit ${prev.idx + 1} (lines ${prev.start}-${prev.end}) overlaps with ` +
					`edit ${curr.idx + 1} (lines ${curr.start}-${curr.end}). ` +
					"Use a single replace for the combined range."
				);
			}
		}
	}

	for (const single of singleReplaces) {
		for (const range of ranges) {
			if (single.line >= range.start && single.line <= range.end) {
				return (
					`Conflicting edits detected: edit ${single.idx + 1} targets line ${single.line}, ` +
					`which is also modified by edit ${range.idx + 1} (lines ${range.start}-${range.end}). ` +
					"Use either single-line or range replace for overlapping lines."
				);
			}
		}
	}

	return null;
}

export interface HashlineApplyReport {
	content: string;
	noopEdits: number;
}

/** Resolve lines from edit.lines field */
function resolveLines(input: string | string[]): string[] {
	return toNewLines(input);
}

/** Apply hashline edits to content. Sorts edits bottom-up (highest line first) to preserve line references. */
export function applyHashlineEdits(content: string, edits: HashlineEdit[]): HashlineApplyReport {
	if (edits.length === 0) {
		return { content, noopEdits: 0 };
	}

	const lines = content.length === 0 ? [] : content.split("\n");

	// Batch validate all line refs upfront
	const refs = collectLineRefs(edits);
	if (refs.length > 0) {
		validateLineRefs(lines, refs);
	}

	const overlapError = detectOverlappingRanges(edits);
	if (overlapError) {
		throw new Error(overlapError);
	}

	const EDIT_PRECEDENCE: Record<HashlineEdit["op"], number> = {
		replace: 0,
		append: 1,
		prepend: 2,
	};

	// Sort bottom-up: highest line numbers first.
	// On same line, apply replacements before insertions.
	const sortedEdits = [...edits].sort((a, b) => {
		const lineDiff = getEditLineNumber(b) - getEditLineNumber(a);
		if (lineDiff !== 0) return lineDiff;
		return EDIT_PRECEDENCE[a.op] - EDIT_PRECEDENCE[b.op];
	});

	let noopEdits = 0;

	for (const edit of sortedEdits) {
		const snapshotBefore = lines.join("\n");

		switch (edit.op) {
			case "replace": {
				if (edit.end) {
					// Range replace (like old replace_lines)
					const { line: startLine } = parseLineRef(edit.pos);
					const { line: endLine } = parseLineRef(edit.end);
					if (startLine > endLine) {
						throw new Error(`Invalid range: start line ${startLine} cannot be greater than end line ${endLine}`);
					}
					const resolved = resolveLines(edit.lines);
					const originalRange = lines.slice(startLine - 1, endLine);
					let newLines = resolved;
					newLines = stripRangeBoundaryEcho(lines, startLine, endLine, newLines);
					newLines = autocorrectReplacementLines(originalRange, newLines);
					newLines = newLines.map((entry, idx) => {
						if (idx !== 0) return entry;
						return restoreLeadingIndent(lines[startLine - 1] ?? "", entry);
					});
					lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
				} else {
					// Single line replace (like old set_line)
					const { line } = parseLineRef(edit.pos);
					const originalLine = lines[line - 1] ?? "";
					let newLines = resolveLines(edit.lines);
					newLines = autocorrectReplacementLines([originalLine], newLines);
					newLines = newLines.map((entry, idx) => {
						if (idx !== 0) return entry;
						return restoreLeadingIndent(originalLine, entry);
					});
					lines.splice(line - 1, 1, ...newLines);
				}
				break;
			}
			case "append": {
				const newLines = resolveLines(edit.lines);
				if (edit.pos) {
					// Anchored append = insert after (like old insert_after)
					const { line } = parseLineRef(edit.pos);
					const stripped = stripInsertAnchorEcho(lines[line - 1] ?? "", newLines);
					if (stripped.length === 0) {
						throw new Error("append: after echo-stripping, no lines remain to insert");
					}
					lines.splice(line, 0, ...stripped);
				} else {
					// Unanchored append = add to EOF
					if (newLines.length === 0) {
						throw new Error("append: lines must not be empty");
					}
					if (lines.length === 1 && lines[0] === "") {
						// Empty file: replace with new content
						lines.splice(0, 1, ...newLines);
					} else {
						lines.push(...newLines);
					}
				}
				break;
			}
			case "prepend": {
				const newLines = resolveLines(edit.lines);
				if (edit.pos) {
					// Anchored prepend = insert before (like old insert_before)
					const { line } = parseLineRef(edit.pos);
					const stripped = stripInsertBeforeEcho(lines[line - 1] ?? "", newLines);
					if (stripped.length === 0) {
						throw new Error("prepend: after echo-stripping, no lines remain to insert");
					}
					lines.splice(line - 1, 0, ...stripped);
				} else {
					// Unanchored prepend = add to BOF
					if (newLines.length === 0) {
						throw new Error("prepend: lines must not be empty");
					}
					if (lines.length === 1 && lines[0] === "") {
						// Empty file: replace with new content
						lines.splice(0, 1, ...newLines);
					} else {
						lines.unshift(...newLines);
					}
				}
				break;
			}
		}

		if (lines.join("\n") === snapshotBefore) {
			noopEdits += 1;
		}
	}

	return { content: lines.join("\n"), noopEdits };
}
