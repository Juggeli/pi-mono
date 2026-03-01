/**
 * Text normalization utilities for hashline edit operations.
 *
 * Handles stripping of hashline prefixes and diff markers from replacement text,
 * and normalizing various text input formats to line arrays.
 */

/** Regex to detect hashline prefixes in text (LINE#ID: or LINE#ID|) */
export const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}[:|]/;

/** Regex to detect unified diff "+" lines (but not +++ headers) */
export const DIFF_PLUS_RE = /^[+](?![+])/;

function equalsIgnoringWhitespace(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function leadingWhitespace(text: string): string {
	if (!text) return "";
	const match = text.match(/^\s*/);
	return match ? match[0] : "";
}

/**
 * Detect and strip hashline or diff prefixes from replacement text lines.
 * Prefix stripping is enabled when at least half of non-empty lines use the same prefix class.
 */
export function stripLinePrefixes(lines: string[]): string[] {
	let hashPrefixCount = 0;
	let diffPlusCount = 0;
	let nonEmpty = 0;

	for (const line of lines) {
		if (line.length === 0) continue;
		nonEmpty += 1;
		if (HASHLINE_PREFIX_RE.test(line)) hashPrefixCount += 1;
		if (DIFF_PLUS_RE.test(line)) diffPlusCount += 1;
	}

	if (nonEmpty === 0) {
		return lines;
	}

	const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5;
	const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;

	if (!stripHash && !stripPlus) {
		return lines;
	}

	return lines.map((line) => {
		if (stripHash) return line.replace(HASHLINE_PREFIX_RE, "");
		if (stripPlus) return line.replace(DIFF_PLUS_RE, "");
		return line;
	});
}

/**
 * Normalize text input to an array of lines with prefix stripping.
 * Accepts a string (split by newlines) or string array.
 */
export function toNewLines(input: string | string[]): string[] {
	if (Array.isArray(input)) {
		return stripLinePrefixes(input);
	}
	return stripLinePrefixes(input.split("\n"));
}

/**
 * Restore leading indentation from a template line to a replacement line.
 * If the replacement intentionally removes indentation, preserve that.
 */
export function restoreLeadingIndent(templateLine: string, line: string): string {
	if (line.length === 0) return line;
	const templateIndent = leadingWhitespace(templateLine);
	if (templateIndent.length === 0) return line;
	if (leadingWhitespace(line).length > 0) return line;
	if (templateLine.trim() === line.trim()) return line;
	return `${templateIndent}${line}`;
}

/**
 * Strip echoed anchor line from insert_after replacement text.
 * If the first line of replacement text matches the anchor line, remove it.
 */
export function stripInsertAnchorEcho(anchorContent: string, lines: string[]): string[] {
	if (lines.length === 0) return lines;
	if (equalsIgnoringWhitespace(lines[0], anchorContent)) {
		return lines.slice(1);
	}
	return lines;
}

/**
 * Strip echoed anchor line from insert_before replacement text.
 * If the last line of replacement text matches the anchor line, remove it.
 */
export function stripInsertBeforeEcho(anchorContent: string, lines: string[]): string[] {
	if (lines.length <= 1) return lines;
	if (equalsIgnoringWhitespace(lines[lines.length - 1], anchorContent)) {
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
	if (equalsIgnoringWhitespace(result[0], afterContent)) {
		result = result.slice(1);
	}
	if (result.length > 0 && equalsIgnoringWhitespace(result[result.length - 1], beforeContent)) {
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
	if (equalsIgnoringWhitespace(result[0], startContent)) {
		result = result.slice(1);
	}
	if (result.length > 0 && equalsIgnoringWhitespace(result[result.length - 1], endContent)) {
		result = result.slice(0, -1);
	}
	return result;
}
