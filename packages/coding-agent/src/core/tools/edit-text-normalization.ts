/**
 * Text normalization utilities for hashline edit operations.
 *
 * Handles stripping of hashline prefixes and diff markers from replacement text,
 * and normalizing various text input formats to line arrays.
 */

import { HASHLINE_PATTERN } from "./hashline.js";

/** Regex to detect hashline prefixes in text (LINE#ID: or LINE:HASH|) */
export const HASHLINE_PREFIX_RE = /^\d+[#:][^\s]*[:|]/;

/** Regex to detect unified diff "+" prefix lines */
export const DIFF_PLUS_RE = /^\+/;

/**
 * Detect and strip hashline or diff prefixes from replacement text lines.
 * If all non-empty lines share a common prefix pattern, strip it.
 */
export function stripLinePrefixes(lines: string[]): string[] {
	if (lines.length === 0) return lines;

	const nonEmpty = lines.filter((l) => l.trim().length > 0);
	if (nonEmpty.length === 0) return lines;

	// Check if all non-empty lines have hashline prefixes
	const allHashline = nonEmpty.every((l) => HASHLINE_PREFIX_RE.test(l));
	if (allHashline) {
		return lines.map((l) => {
			if (l.trim().length === 0) return l;
			const match = l.match(HASHLINE_PATTERN);
			if (match) return match[3];
			// Fallback: strip up to first : or | after the prefix
			const prefixMatch = l.match(/^\d+[#:][^\s]*[:|](.*)/);
			return prefixMatch ? prefixMatch[1] : l;
		});
	}

	// Check if all non-empty lines have diff "+" prefixes
	const allDiffPlus = nonEmpty.every((l) => DIFF_PLUS_RE.test(l));
	if (allDiffPlus) {
		return lines.map((l) => {
			if (l.trim().length === 0) return l;
			return l.replace(DIFF_PLUS_RE, "");
		});
	}

	return lines;
}

/**
 * Normalize text input to an array of lines with prefix stripping.
 * Accepts a string (split by newlines) or string array.
 */
export function toNewLines(input: string | string[]): string[] {
	const lines = typeof input === "string" ? input.split("\n") : input;
	return stripLinePrefixes(lines);
}

/**
 * Restore leading indentation from a template line to a replacement line.
 * If the template line has leading whitespace, apply the same to the replacement.
 */
export function restoreLeadingIndent(templateLine: string, line: string): string {
	const indentMatch = templateLine.match(/^(\s+)/);
	if (!indentMatch) return line;
	const indent = indentMatch[1];
	// Only add indent if the line doesn't already start with whitespace
	if (/^\s/.test(line)) return line;
	return indent + line;
}

/**
 * Strip echoed anchor line from insert_after replacement text.
 * If the first line of replacement text matches the anchor line, remove it.
 */
export function stripInsertAnchorEcho(anchorContent: string, lines: string[]): string[] {
	if (lines.length === 0) return lines;
	if (lines[0].trim() === anchorContent.trim()) {
		return lines.slice(1);
	}
	return lines;
}

/**
 * Strip echoed anchor line from insert_before replacement text.
 * If the last line of replacement text matches the anchor line, remove it.
 */
export function stripInsertBeforeEcho(anchorContent: string, lines: string[]): string[] {
	if (lines.length === 0) return lines;
	if (lines[lines.length - 1].trim() === anchorContent.trim()) {
		return lines.slice(0, -1);
	}
	return lines;
}

/**
 * Strip echoed boundary lines from insert_between replacement text.
 * If the first/last lines match the after/before anchors, remove them.
 */
export function stripInsertBoundaryEcho(afterContent: string, beforeContent: string, lines: string[]): string[] {
	if (lines.length === 0) return lines;
	let result = lines;
	if (result[0].trim() === afterContent.trim()) {
		result = result.slice(1);
	}
	if (result.length > 0 && result[result.length - 1].trim() === beforeContent.trim()) {
		result = result.slice(0, -1);
	}
	return result;
}

/**
 * Strip echoed boundary lines from replace_lines/replace replacement text.
 * If the first line matches start and last matches end, remove them.
 */
export function stripRangeBoundaryEcho(startContent: string, endContent: string, lines: string[]): string[] {
	if (lines.length < 2) return lines;
	let result = lines;
	if (result[0].trim() === startContent.trim()) {
		result = result.slice(1);
	}
	if (result.length > 0 && result[result.length - 1].trim() === endContent.trim()) {
		result = result.slice(0, -1);
	}
	return result;
}
