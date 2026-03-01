/**
 * Deduplication of hashline edits.
 *
 * Removes semantically identical edits that may be submitted multiple times
 * (e.g. retries, formatting variants, or model repetition).
 */

import { toNewLines } from "./edit-text-normalization.js";
import { type HashlineEdit, normalizeLineRef } from "./hashline.js";

function normalizeEditPayload(payload: string): string {
	const normalizedNewlines = payload.replace(/\\n/g, "\n");
	return toNewLines(normalizedNewlines).join("\n");
}

function canonicalAnchor(anchor: string | undefined): string {
	if (!anchor) return "";
	return normalizeLineRef(anchor);
}

function buildDedupeKey(edit: HashlineEdit): string {
	switch (edit.type) {
		case "set_line":
			return `set_line|${canonicalAnchor(edit.line)}|${normalizeEditPayload(edit.text)}`;
		case "replace_lines":
			return `replace|${canonicalAnchor(edit.start_line)}|${canonicalAnchor(edit.end_line)}|${normalizeEditPayload(edit.text)}`;
		case "replace":
			return `replace|${canonicalAnchor(edit.start_line)}|${canonicalAnchor(edit.end_line)}|${normalizeEditPayload(edit.text)}`;
		case "insert_after":
			return `insert_after|${canonicalAnchor(edit.line)}|${normalizeEditPayload(edit.text)}`;
		case "insert_before":
			return `insert_before|${canonicalAnchor(edit.line)}|${normalizeEditPayload(edit.text)}`;
		case "insert_between":
			return `insert_between|${canonicalAnchor(edit.after_line)}|${canonicalAnchor(edit.before_line)}|${normalizeEditPayload(edit.text)}`;
		case "append":
			return `append|${normalizeEditPayload(edit.text)}`;
		case "prepend":
			return `prepend|${normalizeEditPayload(edit.text)}`;
	}
}

/**
 * Deduplicate semantically identical edits.
 * Returns the unique edits and the count of duplicates removed.
 */
export function dedupeEdits(edits: HashlineEdit[]): { edits: HashlineEdit[]; duplicatesRemoved: number } {
	const seen = new Set<string>();
	const unique: HashlineEdit[] = [];
	let duplicatesRemoved = 0;

	for (const edit of edits) {
		const key = buildDedupeKey(edit);
		if (seen.has(key)) {
			duplicatesRemoved++;
		} else {
			seen.add(key);
			unique.push(edit);
		}
	}

	return { edits: unique, duplicatesRemoved };
}
