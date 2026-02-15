/**
 * Fuzzy Edit Tool Extension for pi
 *
 * Overrides the built-in edit tool with high-confidence fuzzy matching for oldText.
 * Handles whitespace and indentation variance automatically.
 *
 * Features:
 * - High-confidence fuzzy matching for oldText in edit operations
 * - Fixes the #1 pain point: edits failing due to invisible whitespace differences
 * - Configurable via edit.fuzzyMatch setting (enabled by default)
 * - Levenshtein distance-based similarity scoring
 * - Line-level and character-level matching strategies
 * - Smart indentation adjustment for newText
 *
 * Installation: Copy to ~/.pi/agent/extensions/fuzzy-edit.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { resolve } from "path";
import * as Diff from "diff";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Default similarity threshold for fuzzy matching (0.95 = 95%) */
const DEFAULT_FUZZY_THRESHOLD = 0.95;



/** Fallback threshold for line-based matching */
const FALLBACK_THRESHOLD = 0.8;

/** Context lines to show before/after an ambiguous match preview */
const OCCURRENCE_PREVIEW_CONTEXT = 5;

/** Maximum line length for ambiguous match previews */
const OCCURRENCE_PREVIEW_MAX_LEN = 80;

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface FuzzyMatch {
	/** The actual text that was matched */
	actualText: string;
	/** Character index where the match starts */
	startIndex: number;
	/** Line number where the match starts (1-indexed) */
	startLine: number;
	/** Confidence score (0-1, where 1 is exact match) */
	confidence: number;
}

interface MatchOutcome {
	/** The match if found with sufficient confidence */
	match?: FuzzyMatch;
	/** The closest match found (may be below threshold) */
	closest?: FuzzyMatch;
	/** Number of occurrences if multiple exact matches found */
	occurrences?: number;
	/** Line numbers where occurrences were found (1-indexed) */
	occurrenceLines?: number[];
	/** Preview snippets for each occurrence (up to 5) */
	occurrencePreviews?: string[];
	/** Number of fuzzy matches above threshold */
	fuzzyMatches?: number;
	/** True when a dominant fuzzy match was accepted despite multiple candidates */
	dominantFuzzy?: boolean;
}

interface ReplaceResult {
	/** The new content after replacements */
	content: string;
	/** Number of replacements made */
	count: number;
}

interface DiffResult {
	/** The unified diff string */
	diff: string;
	/** Line number of the first change in the new file */
	firstChangedLine?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Levenshtein Distance & Similarity
// ═══════════════════════════════════════════════════════════════════════════

/** Compute Levenshtein distance between two strings */
function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

/** Compute similarity score between two strings (0 to 1) */
function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalization
// ═══════════════════════════════════════════════════════════════════════════

/** Normalize common Unicode punctuation to ASCII equivalents */
function normalizeUnicode(s: string): string {
	return s
		.trim()
		.split("")
		.map((c) => {
			const code = c.charCodeAt(0);

			// Various dashes/hyphens → ASCII '-'
			if (
				code === 0x2010 || // HYPHEN
				code === 0x2011 || // NON-BREAKING HYPHEN
				code === 0x2012 || // FIGURE DASH
				code === 0x2013 || // EN DASH
				code === 0x2014 || // EM DASH
				code === 0x2015 || // HORIZONTAL BAR
				code === 0x2212 // MINUS SIGN
			) {
				return "-";
			}

			// Fancy single quotes → '
			if (
				code === 0x2018 || // LEFT SINGLE QUOTATION MARK
				code === 0x2019 || // RIGHT SINGLE QUOTATION MARK
				code === 0x201a || // SINGLE LOW-9 QUOTATION MARK
				code === 0x201b // SINGLE HIGH-REVERSED-9 QUOTATION MARK
			) {
				return "'";
			}

			// Fancy double quotes → "
			if (
				code === 0x201c || // LEFT DOUBLE QUOTATION MARK
				code === 0x201d || // RIGHT DOUBLE QUOTATION MARK
				code === 0x201e || // DOUBLE LOW-9 QUOTATION MARK
				code === 0x201f // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
			) {
				return '"';
			}

			// Non-breaking spaces → normal space
			if (
				code === 0x00a0 || // NO-BREAK SPACE
				code === 0x2002 || // EN SPACE
				code === 0x2003 || // EM SPACE
				code === 0x2004 || // THREE-PER-EM SPACE
				code === 0x2005 || // FOUR-PER-EM SPACE
				code === 0x2006 || // SIX-PER-EM SPACE
				code === 0x2007 || // FIGURE SPACE
				code === 0x2008 || // PUNCTUATION SPACE
				code === 0x2009 || // THIN SPACE
				code === 0x200a || // HAIR SPACE
				code === 0x202f || // NARROW NO-BREAK SPACE
				code === 0x205f || // MEDIUM MATHEMATICAL SPACE
				code === 0x3000 // IDEOGRAPHIC SPACE
			) {
				return " ";
			}

			return c;
		})
		.join("");
}

/** Normalize a line for fuzzy comparison */
function normalizeForFuzzy(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length === 0) return "";

	return normalizeUnicode(trimmed)
		.replace(/[\""„‟«»]/g, '"')
		.replace(/[''‚‛`´]/g, "'")
		.replace(/[‐‑‒–—−]/g, "-")
		.replace(/[ \t]+/g, " ");
}

/** Detect line ending in content */
function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Normalize all line endings to LF */
function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Restore line endings to the specified type */
function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip UTF-8 BOM if present */
function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Count leading whitespace characters in a line */
function countLeadingWhitespace(line: string): number {
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === " " || char === "\t") {
			count++;
		} else {
			break;
		}
	}
	return count;
}

/** Get the leading whitespace string from a line */
function getLeadingWhitespace(line: string): string {
	return line.slice(0, countLeadingWhitespace(line));
}

// ═══════════════════════════════════════════════════════════════════════════
// Indentation Adjustment
// ═══════════════════════════════════════════════════════════════════════════

interface IndentProfile {
	lines: string[];
	indentStrings: string[];
	indentCounts: number[];
	min: number;
	char: " " | "\t" | undefined;
	spaceOnly: boolean;
	tabOnly: boolean;
	mixed: boolean;
	unit: number;
	nonEmptyCount: number;
}

function buildIndentProfile(text: string): IndentProfile {
	const lines = text.split("\n");
	const indentStrings: string[] = [];
	const indentCounts: number[] = [];
	let min = Infinity;
	let char: " " | "\t" | undefined;
	let spaceOnly = true;
	let tabOnly = true;
	let mixed = false;
	let nonEmptyCount = 0;
	let unit = 0;

	for (const line of lines) {
		if (line.trim().length === 0) continue;
		nonEmptyCount++;
		const indent = getLeadingWhitespace(line);
		indentStrings.push(indent);
		indentCounts.push(indent.length);
		min = Math.min(min, indent.length);
		if (indent.includes(" ")) {
			tabOnly = false;
		}
		if (indent.includes("\t")) {
			spaceOnly = false;
		}
		if (indent.includes(" ") && indent.includes("\t")) {
			mixed = true;
		}
		if (indent.length > 0) {
			const currentChar = indent[0] as " " | "\t";
			if (!char) {
				char = currentChar;
			} else if (char !== currentChar) {
				mixed = true;
			}
		}
	}

	if (min === Infinity) {
		min = 0;
	}

	if (spaceOnly && nonEmptyCount > 0) {
		let current = 0;
		for (const count of indentCounts) {
			if (count === 0) continue;
			current = current === 0 ? count : gcd(current, count);
		}
		unit = current;
	}

	if (tabOnly && nonEmptyCount > 0) {
		unit = 1;
	}

	return {
		lines,
		indentStrings,
		indentCounts,
		min,
		char,
		spaceOnly,
		tabOnly,
		mixed,
		unit,
		nonEmptyCount,
	};
}

function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const temp = y;
		y = x % y;
		x = temp;
	}
	return x;
}

function detectIndentChar(text: string): string {
	const lines = text.split("\n");
	for (const line of lines) {
		const ws = getLeadingWhitespace(line);
		if (ws.length > 0) {
			return ws[0];
		}
	}
	return " ";
}

function convertLeadingTabsToSpaces(text: string, spacesPerTab: number): string {
	if (spacesPerTab <= 0) return text;
	return text
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.length === 0) return line;
			const leading = getLeadingWhitespace(line);
			if (!leading.includes("\t") || leading.includes(" ")) return line;
			const converted = " ".repeat(leading.length * spacesPerTab);
			return converted + trimmed;
		})
		.join("\n");
}

/**
 * Adjust newText indentation to match the indentation delta between
 * what was provided (oldText) and what was actually matched (actualText).
 */
function adjustIndentation(oldText: string, actualText: string, newText: string): string {
	// If old text already matches actual text exactly, preserve agent's intended indentation
	if (oldText === actualText) {
		return newText;
	}

	// If the patch is purely an indentation change (same trimmed content), apply exactly as specified
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	if (oldLines.length === newLines.length) {
		let indentationOnly = true;
		for (let i = 0; i < oldLines.length; i++) {
			if (oldLines[i].trim() !== newLines[i].trim()) {
				indentationOnly = false;
				break;
			}
		}
		if (indentationOnly) {
			return newText;
		}
	}

	const oldProfile = buildIndentProfile(oldText);
	const actualProfile = buildIndentProfile(actualText);
	const newProfile = buildIndentProfile(newText);

	if (newProfile.nonEmptyCount === 0 || oldProfile.nonEmptyCount === 0 || actualProfile.nonEmptyCount === 0) {
		return newText;
	}

	if (oldProfile.mixed || actualProfile.mixed || newProfile.mixed) {
		return newText;
	}

	if (oldProfile.char && actualProfile.char && oldProfile.char !== actualProfile.char) {
		if (actualProfile.spaceOnly && oldProfile.tabOnly && newProfile.tabOnly && actualProfile.unit > 0) {
			let consistent = true;
			const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
			for (let i = 0; i < lineCount; i++) {
				const oldLine = oldProfile.lines[i];
				const actualLine = actualProfile.lines[i];
				if (oldLine.trim().length === 0 || actualLine.trim().length === 0) continue;
				const oldIndent = getLeadingWhitespace(oldLine);
				const actualIndent = getLeadingWhitespace(actualLine);
				if (oldIndent.length === 0) continue;
				if (actualIndent.length !== oldIndent.length * actualProfile.unit) {
					consistent = false;
					break;
				}
			}
			return consistent ? convertLeadingTabsToSpaces(newText, actualProfile.unit) : newText;
		}
		return newText;
	}

	const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
	const deltas: number[] = [];
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldProfile.lines[i];
		const actualLine = actualProfile.lines[i];
		if (oldLine.trim().length === 0 || actualLine.trim().length === 0) continue;
		deltas.push(countLeadingWhitespace(actualLine) - countLeadingWhitespace(oldLine));
	}

	if (deltas.length === 0) {
		return newText;
	}

	const delta = deltas[0];
	if (!deltas.every((value) => value === delta)) {
		return newText;
	}

	if (delta === 0) {
		return newText;
	}

	if (newProfile.char && actualProfile.char && newProfile.char !== actualProfile.char) {
		return newText;
	}

	const indentChar = actualProfile.char ?? oldProfile.char ?? detectIndentChar(actualText);
	const adjusted = newText.split("\n").map((line) => {
		if (line.trim().length === 0) {
			return line;
		}
		if (delta > 0) {
			return indentChar.repeat(delta) + line;
		}
		const toRemove = Math.min(-delta, countLeadingWhitespace(line));
		return line.slice(toRemove);
	});

	return adjusted.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Fuzzy Matching Core
// ═══════════════════════════════════════════════════════════════════════════

function computeLineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets.push(offset);
		offset += lines[i].length;
		if (i < lines.length - 1) offset += 1; // newline
	}
	return offsets;
}

function computeRelativeIndentDepths(lines: string[]): number[] {
	const indents = lines.map(countLeadingWhitespace);
	const nonEmptyIndents: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().length > 0) {
			nonEmptyIndents.push(indents[i]);
		}
	}
	const minIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;
	const indentSteps = nonEmptyIndents.map((indent) => indent - minIndent).filter((step) => step > 0);
	const indentUnit = indentSteps.length > 0 ? Math.min(...indentSteps) : 1;

	return lines.map((line, index) => {
		if (line.trim().length === 0) return 0;
		if (indentUnit <= 0) return 0;
		const relativeIndent = indents[index] - minIndent;
		return Math.round(relativeIndent / indentUnit);
	});
}

function normalizeLines(lines: string[], includeDepth = true): string[] {
	const indentDepths = includeDepth ? computeRelativeIndentDepths(lines) : null;
	return lines.map((line, index) => {
		const trimmed = line.trim();
		const prefix = indentDepths ? `${indentDepths[index]}|` : "|";
		if (trimmed.length === 0) return prefix;
		return `${prefix}${normalizeForFuzzy(trimmed)}`;
	});
}

interface BestFuzzyMatchResult {
	best?: FuzzyMatch;
	aboveThresholdCount: number;
	secondBestScore: number;
}

function findBestFuzzyMatchCore(
	contentLines: string[],
	targetLines: string[],
	offsets: number[],
	threshold: number,
	includeDepth: boolean,
): BestFuzzyMatchResult {
	const targetNormalized = normalizeLines(targetLines, includeDepth);

	let best: FuzzyMatch | undefined;
	let bestScore = -1;
	let secondBestScore = -1;
	let aboveThresholdCount = 0;

	for (let start = 0; start <= contentLines.length - targetLines.length; start++) {
		const windowLines = contentLines.slice(start, start + targetLines.length);
		const windowNormalized = normalizeLines(windowLines, includeDepth);
		let score = 0;
		for (let i = 0; i < targetLines.length; i++) {
			score += similarity(targetNormalized[i], windowNormalized[i]);
		}
		score = score / targetLines.length;

		if (score >= threshold) {
			aboveThresholdCount++;
		}

		if (score > bestScore) {
			secondBestScore = bestScore;
			bestScore = score;
			best = {
				actualText: windowLines.join("\n"),
				startIndex: offsets[start],
				startLine: start + 1,
				confidence: score,
			};
		} else if (score > secondBestScore) {
			secondBestScore = score;
		}
	}

	return { best, aboveThresholdCount, secondBestScore };
}

function findBestFuzzyMatch(content: string, target: string, threshold: number): BestFuzzyMatchResult {
	const contentLines = content.split("\n");
	const targetLines = target.split("\n");

	if (targetLines.length === 0 || target.length === 0) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}
	if (targetLines.length > contentLines.length) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}

	const offsets = computeLineOffsets(contentLines);
	let result = findBestFuzzyMatchCore(contentLines, targetLines, offsets, threshold, true);

	// Retry without indent depth if match is close but below threshold
	if (result.best && result.best.confidence < threshold && result.best.confidence >= FALLBACK_THRESHOLD) {
		const noDepthResult = findBestFuzzyMatchCore(contentLines, targetLines, offsets, threshold, false);
		if (noDepthResult.best && noDepthResult.best.confidence > result.best!.confidence) {
			result = noDepthResult;
		}
	}

	return result;
}

/**
 * Find a match for target text within content.
 */
function findMatch(content: string, target: string, options: { allowFuzzy: boolean; threshold?: number }): MatchOutcome {
	if (target.length === 0) {
		return {};
	}

	// Try exact match first
	const exactIndex = content.indexOf(target);
	if (exactIndex !== -1) {
		const occurrences = content.split(target).length - 1;
		if (occurrences > 1) {
			// Find line numbers and previews for each occurrence (up to 5)
			const contentLines = content.split("\n");
			const occurrenceLines: number[] = [];
			const occurrencePreviews: string[] = [];
			let searchStart = 0;
			for (let i = 0; i < 5; i++) {
				const idx = content.indexOf(target, searchStart);
				if (idx === -1) break;
				const lineNumber = content.slice(0, idx).split("\n").length;
				occurrenceLines.push(lineNumber);
				const start = Math.max(0, lineNumber - 1 - OCCURRENCE_PREVIEW_CONTEXT);
				const end = Math.min(contentLines.length, lineNumber + OCCURRENCE_PREVIEW_CONTEXT + 1);
				const previewLines = contentLines.slice(start, end);
				const preview = previewLines
					.map((line, idx) => {
						const num = start + idx + 1;
						const displayLine =
							line.length > OCCURRENCE_PREVIEW_MAX_LEN ? `${line.slice(0, OCCURRENCE_PREVIEW_MAX_LEN - 1)}…` : line;
						return `  ${num} | ${displayLine}`;
					})
					.join("\n");
				occurrencePreviews.push(preview);
				searchStart = idx + 1;
			}
			return { occurrences, occurrenceLines, occurrencePreviews };
		}
		const startLine = content.slice(0, exactIndex).split("\n").length;
		return {
			match: {
				actualText: target,
				startIndex: exactIndex,
				startLine,
				confidence: 1,
			},
		};
	}

	// Try fuzzy match
	const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
	const { best, aboveThresholdCount, secondBestScore } = findBestFuzzyMatch(content, target, threshold);

	if (!best) {
		return {};
	}

	if (options.allowFuzzy && best.confidence >= threshold) {
		if (aboveThresholdCount === 1) {
			return { match: best, closest: best };
		}
		const dominantDelta = 0.08;
		const dominantMin = 0.97;
		if (
			aboveThresholdCount > 1 &&
			best.confidence >= dominantMin &&
			best.confidence - secondBestScore >= dominantDelta
		) {
			return { match: best, closest: best, fuzzyMatches: aboveThresholdCount, dominantFuzzy: true };
		}
	}

	return { closest: best, fuzzyMatches: aboveThresholdCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// Replace Text Logic
// ═══════════════════════════════════════════════════════════════════════════

function generateDiffString(oldContent: string, newContent: string, contextLines = 4): DiffResult {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const maxLineNum = Math.max(
		oldContent.split("\n").length,
		newContent.split("\n").length,
	);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					const padded = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${padded}|${line}`);
					newLineNum++;
				} else {
					const padded = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${padded}|${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")}|...`);
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}

				for (const line of linesToShow) {
					const padded = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${padded}|${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")}|...`);
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}
			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

interface ReplaceOptions {
	/** Allow fuzzy matching */
	fuzzy: boolean;
	/** Replace all occurrences */
	all: boolean;
	/** Similarity threshold for fuzzy matching */
	threshold?: number;
}

interface MatchInfo {
	actualText: string;
	startIndex: number;
	adjustedNewText: string;
}

function findAllMatches(
	content: string,
	oldText: string,
	newText: string,
	options: { fuzzy: boolean; threshold: number },
): MatchInfo[] {
	const matches: MatchInfo[] = [];
	let searchStart = 0;

	while (searchStart <= content.length) {
		const matchOutcome = findMatch(content.slice(searchStart), oldText, {
			allowFuzzy: options.fuzzy,
			threshold: options.threshold,
		});

		// Check for ambiguous multiple exact matches
		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
			const moreMsg = matchOutcome.occurrences > 5 ? ` (showing first 5 of ${matchOutcome.occurrences})` : "";
			throw new Error(
				`Found ${matchOutcome.occurrences} occurrences${moreMsg}:\n\n${previews}\n\n` +
					`Add more context lines to disambiguate.`,
			);
		}

		const shouldUseClosest =
			options.fuzzy &&
			matchOutcome.closest &&
			matchOutcome.closest.confidence >= options.threshold &&
			(matchOutcome.fuzzyMatches === undefined || matchOutcome.fuzzyMatches <= 1);
		const match = matchOutcome.match || (shouldUseClosest ? matchOutcome.closest : undefined);

		if (!match) {
			break;
		}

		const adjustedNewText = adjustIndentation(oldText, match.actualText, newText);
		const absoluteStart = searchStart + match.startIndex;

		// Skip zero-length matches to prevent infinite loops
		if (match.actualText.length === 0) {
			searchStart = absoluteStart + 1;
			continue;
		}

		matches.push({
			actualText: match.actualText,
			startIndex: absoluteStart,
			adjustedNewText,
		});

		// Continue searching after this match
		searchStart = absoluteStart + match.actualText.length;
	}

	return matches;
}

function replaceText(content: string, oldText: string, newText: string, options: ReplaceOptions): ReplaceResult {
	if (oldText.length === 0) {
		throw new Error("oldText must not be empty.");
	}
	const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
	let normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(oldText);
	const normalizedNewText = normalizeToLF(newText);

	if (options.all) {
		// Check for exact matches first
		const exactCount = normalizedContent.split(normalizedOldText).length - 1;
		if (exactCount > 0) {
			return {
				content: normalizedContent.split(normalizedOldText).join(normalizedNewText),
				count: exactCount,
			};
		}

		// No exact matches - find all fuzzy matches, then replace from end to start
		const matches = findAllMatches(normalizedContent, normalizedOldText, normalizedNewText, {
			fuzzy: options.fuzzy,
			threshold,
		});

		// Sort by startIndex descending to replace from end to start
		// (prevents index shifting issues)
		const sortedMatches = matches.sort((a, b) => b.startIndex - a.startIndex);

		for (const match of sortedMatches) {
			normalizedContent =
				normalizedContent.substring(0, match.startIndex) +
				match.adjustedNewText +
				normalizedContent.substring(match.startIndex + match.actualText.length);
		}

		return { content: normalizedContent, count: matches.length };
	}

	// Single replacement mode
	const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
		allowFuzzy: options.fuzzy,
		threshold,
	});

	if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
		const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
		const moreMsg = matchOutcome.occurrences > 5 ? ` (showing first 5 of ${matchOutcome.occurrences})` : "";
		throw new Error(
			`Found ${matchOutcome.occurrences} occurrences${moreMsg}:\n\n${previews}\n\n` +
				`Add more context lines to disambiguate.`,
		);
	}

	if (!matchOutcome.match) {
		return { content: normalizedContent, count: 0 };
	}

	const match = matchOutcome.match;
	const adjustedNewText = adjustIndentation(normalizedOldText, match.actualText, normalizedNewText);
	normalizedContent =
		normalizedContent.substring(0, match.startIndex) +
		adjustedNewText +
		normalizedContent.substring(match.startIndex + match.actualText.length);

	return { content: normalizedContent, count: 1 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Error Formatting
// ═══════════════════════════════════════════════════════════════════════════

function findFirstDifferentLine(oldLines: string[], newLines: string[]): { oldLine: string; newLine: string } {
	const max = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < max; i++) {
		const oldLine = oldLines[i] ?? "";
		const newLine = newLines[i] ?? "";
		if (oldLine !== newLine) {
			return { oldLine, newLine };
		}
	}
	return { oldLine: oldLines[0] ?? "", newLine: newLines[0] ?? "" };
}

function formatMatchError(
	path: string,
	searchText: string,
	closest: FuzzyMatch | undefined,
	options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
): string {
	if (!closest) {
		return options.allowFuzzy
			? `Could not find a close enough match in ${path}.`
			: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
	}

	const similarity = Math.round(closest.confidence * 100);
	const searchLines = searchText.split("\n");
	const actualLines = closest.actualText.split("\n");
	const { oldLine, newLine } = findFirstDifferentLine(searchLines, actualLines);
	const thresholdPercent = Math.round(options.threshold * 100);

	const hint = options.allowFuzzy
		? options.fuzzyMatches && options.fuzzyMatches > 1
			? `Found ${options.fuzzyMatches} high-confidence matches. Provide more context to make it unique.`
			: `Closest match was below the ${thresholdPercent}% similarity threshold.`
		: "Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence matches.";

	return [
		options.allowFuzzy ? `Could not find a close enough match in ${path}.` : `Could not find the exact text in ${path}.`,
		``,
		`Closest match (${similarity}% similar) at line ${closest.startLine}:`,
		`  - ${oldLine}`,
		`  + ${newLine}`,
		hint,
	].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Export
// ═══════════════════════════════════════════════════════════════════════════

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute). Shell shortcuts like ~ are not expanded." }),
	oldText: Type.String({ description: "Text to find (fuzzy whitespace matching enabled)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
	all: Type.Optional(Type.Boolean({ description: "Replace all occurrences (default: unique match required)" })),
});

export default function (pi: ExtensionAPI) {
	// Read settings from environment or use defaults
	const envFuzzy = process.env.PI_EDIT_FUZZY;
	const envThreshold = process.env.PI_EDIT_FUZZY_THRESHOLD;

	let allowFuzzy = true;
	if (envFuzzy === "false" || envFuzzy === "0") {
		allowFuzzy = false;
	}

	let fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD;
	if (envThreshold) {
		const parsed = parseFloat(envThreshold);
		if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
			fuzzyThreshold = parsed;
		}
	}

	pi.registerTool({
		name: "edit",
		label: "Edit (Fuzzy)",
		description:
			"Edit a file by replacing text with high-confidence fuzzy matching. " +
			"Handles whitespace and indentation variance automatically. " +
			"The oldText is matched using Levenshtein distance-based similarity scoring. " +
			"Requires unique match unless 'all' is set to true.",
		parameters: editSchema,

		async execute(_toolCallId, params, signal): Promise<{ content: TextContent[]; details: { diff: string; firstChangedLine?: number } }> {
			const { path, oldText, newText, all } = params;
			const cwd = process.cwd();
			const absolutePath = resolve(cwd, path);

			// Check if already aborted
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Check if path contains shell expansion that won't work
			if (path.startsWith("~")) {
				throw new Error(
					`Path contains '~' which requires shell expansion. ` +
					`Please use an absolute path (e.g., /home/username/...) or relative path instead of: ${path}`
				);
			}

			// Check if file exists
			try {
				await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
			} catch {
				throw new Error(`File not found: ${path}`);
			}

			// Read the file
			const buffer = await fsReadFile(absolutePath);
			const rawContent = buffer.toString("utf-8");

			// Check if aborted
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Strip BOM before matching
			const { bom, text: content } = stripBom(rawContent);
			const originalEnding = detectLineEnding(content);
			const normalizedContent = normalizeToLF(content);
			const normalizedOldText = normalizeToLF(oldText);
			const normalizedNewText = normalizeToLF(newText);

			// Perform replacement using fuzzy matching
			const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
				fuzzy: allowFuzzy,
				all: all ?? false,
				threshold: fuzzyThreshold,
			});

			if (result.count === 0) {
				// Get error details
				const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
					allowFuzzy: allowFuzzy,
					threshold: fuzzyThreshold,
				});

				if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
					const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
					const moreMsg = matchOutcome.occurrences > 5 ? ` (showing first 5 of ${matchOutcome.occurrences})` : "";
					throw new Error(
						`Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\n` +
							`Add more context lines to disambiguate.`,
					);
				}

				throw new Error(
					formatMatchError(path, normalizedOldText, matchOutcome.closest, {
						allowFuzzy: allowFuzzy,
						threshold: fuzzyThreshold,
						fuzzyMatches: matchOutcome.fuzzyMatches,
					}),
				);
			}

			if (normalizedContent === result.content) {
				throw new Error(
					`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
				);
			}

			// Write the file
			const finalContent = bom + restoreLineEndings(result.content, originalEnding);
			await fsWriteFile(absolutePath, finalContent, "utf-8");

			// Generate diff for display
			const diffResult = generateDiffString(normalizedContent, result.content);

			const resultText =
				result.count > 1
					? `Successfully replaced ${result.count} occurrences in ${path}.`
					: `Successfully replaced text in ${path}.`;

			return {
				content: [{ type: "text", text: resultText }],
				details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
			};
		},
	});

	// Register a command to toggle fuzzy matching
	pi.registerCommand("fuzzy-edit", {
		description: "Toggle fuzzy matching for edit tool (on/off/status)",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase() || "status";

			if (arg === "on" || arg === "true" || arg === "1") {
				allowFuzzy = true;
				ctx.ui.notify("Fuzzy edit matching enabled", "success");
			} else if (arg === "off" || arg === "false" || arg === "0") {
				allowFuzzy = false;
				ctx.ui.notify("Fuzzy edit matching disabled", "info");
			} else {
				ctx.ui.notify(`Fuzzy edit matching is ${allowFuzzy ? "enabled" : "disabled"} (threshold: ${Math.round(fuzzyThreshold * 100)}%)`, "info");
			}
		},
	});
}
