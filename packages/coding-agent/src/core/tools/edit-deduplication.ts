/**
 * Deduplication of hashline edits.
 *
 * Removes identical edits that may be submitted multiple times
 * (e.g., from retry logic or model repetition).
 */

import type { HashlineEdit } from "./hashline.js";

/**
 * Deduplicate identical edits by JSON serialization comparison.
 * Returns the unique edits and the count of duplicates removed.
 */
export function dedupeEdits(edits: HashlineEdit[]): { edits: HashlineEdit[]; duplicatesRemoved: number } {
	const seen = new Set<string>();
	const unique: HashlineEdit[] = [];
	let duplicatesRemoved = 0;

	for (const edit of edits) {
		const key = JSON.stringify(edit);
		if (seen.has(key)) {
			duplicatesRemoved++;
		} else {
			seen.add(key);
			unique.push(edit);
		}
	}

	return { edits: unique, duplicatesRemoved };
}
