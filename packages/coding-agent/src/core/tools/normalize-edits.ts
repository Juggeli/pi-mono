/**
 * Normalize flexible edit input into typed HashlineEdit objects.
 *
 * LLMs may produce edits with various field names. This normalization layer
 * maps flexible input shapes to the canonical HashlineEdit union types.
 */

import type {
	AppendEdit,
	HashlineEdit,
	InsertAfterEdit,
	InsertBeforeEdit,
	InsertBetweenEdit,
	PrependEdit,
	ReplaceEdit,
	ReplaceLinesEdit,
	SetLineEdit,
} from "./hashline.js";

/**
 * Flexible edit shape that accepts all possible field names.
 * The normalization layer resolves these to typed HashlineEdit objects.
 */
export interface RawHashlineEdit {
	type: string;
	line?: string;
	start_line?: string;
	end_line?: string;
	after_line?: string;
	before_line?: string;
	text?: string;
	content?: string;
}

/** Get text from a raw edit, trying "text" first then "content" */
function getText(raw: RawHashlineEdit): string {
	return raw.text ?? raw.content ?? "";
}

/** Try multiple field names for a line reference */
function getLineRef(raw: RawHashlineEdit, ...fields: (keyof RawHashlineEdit)[]): string {
	for (const field of fields) {
		const val = raw[field];
		if (typeof val === "string" && val.length > 0) return val;
	}
	throw new Error(`Missing line reference for ${raw.type}. Tried fields: ${fields.join(", ")}`);
}

/**
 * Normalize an array of flexible edit objects into typed HashlineEdit objects.
 * Supports alias fallback chains for field resolution.
 */
export function normalizeHashlineEdits(rawEdits: RawHashlineEdit[]): HashlineEdit[] {
	return rawEdits.map((raw): HashlineEdit => {
		switch (raw.type) {
			case "set_line": {
				const edit: SetLineEdit = {
					type: "set_line",
					line: getLineRef(raw, "line", "start_line"),
					text: getText(raw),
				};
				return edit;
			}

			case "replace_lines": {
				const edit: ReplaceLinesEdit = {
					type: "replace_lines",
					start_line: getLineRef(raw, "start_line", "line"),
					end_line: getLineRef(raw, "end_line"),
					text: getText(raw),
				};
				return edit;
			}

			case "insert_after": {
				const edit: InsertAfterEdit = {
					type: "insert_after",
					line: getLineRef(raw, "line", "after_line", "end_line", "start_line"),
					text: getText(raw),
				};
				return edit;
			}

			case "insert_before": {
				const edit: InsertBeforeEdit = {
					type: "insert_before",
					line: getLineRef(raw, "line", "before_line", "start_line"),
					text: getText(raw),
				};
				return edit;
			}

			case "insert_between": {
				const edit: InsertBetweenEdit = {
					type: "insert_between",
					after_line: getLineRef(raw, "after_line", "start_line"),
					before_line: getLineRef(raw, "before_line", "end_line"),
					text: getText(raw),
				};
				return edit;
			}

			case "replace": {
				const edit: ReplaceEdit = {
					type: "replace",
					start_line: getLineRef(raw, "start_line", "line"),
					end_line: getLineRef(raw, "end_line"),
					text: getText(raw),
				};
				return edit;
			}

			case "append": {
				const edit: AppendEdit = {
					type: "append",
					text: getText(raw),
				};
				return edit;
			}

			case "prepend": {
				const edit: PrependEdit = {
					type: "prepend",
					text: getText(raw),
				};
				return edit;
			}

			default:
				throw new Error(`Unknown edit type: "${raw.type}"`);
		}
	});
}
