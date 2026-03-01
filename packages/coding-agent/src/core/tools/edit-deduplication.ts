/**
 * Deduplication of hashline edits.
 *
 * Removes semantically identical edits that may be submitted multiple times
 * (e.g. retries, formatting variants, or model repetition).
 */

import { toNewLines } from "./edit-text-normalization.js";
import { type HashlineEdit, normalizeLineRef } from "./hashline.js";

function normalizeEditPayload(payload: string | string[]): string {
	return toNewLines(payload).join("\n");
}

function canonicalAnchor(anchor: string | undefined): string {
	if (!anchor) return "";
	return normalizeLineRef(anchor);
}

function buildDedupeKey(edit: HashlineEdit): string {
	switch (edit.op) {
		case "replace":
			return `replace|${canonicalAnchor(edit.pos)}|${canonicalAnchor(edit.end)}|${normalizeEditPayload(edit.lines)}`;
		case "append":
			return `append|${canonicalAnchor(edit.pos)}|${normalizeEditPayload(edit.lines)}`;
		case "prepend":
			return `prepend|${canonicalAnchor(edit.pos)}|${normalizeEditPayload(edit.lines)}`;
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
