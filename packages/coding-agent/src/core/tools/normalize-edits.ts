/**
 * Normalize flexible edit input into typed HashlineEdit objects.
 *
 * LLMs may produce edits with various field names. This normalization layer
 * maps flexible input shapes to the canonical HashlineEdit union types.
 */

import type { AppendEdit, HashlineEdit, PrependEdit, ReplaceEdit } from "./hashline.js";

/**
 * Flexible edit shape that accepts all possible field names.
 * The normalization layer resolves these to typed HashlineEdit objects.
 */
export interface RawHashlineEdit {
	op?: string;
	/** Legacy field: mapped to op */
	type?: string;
	pos?: string;
	end?: string;
	lines?: string | string[] | null;
	/** Legacy field: mapped to pos */
	line?: string;
	/** Legacy field: mapped to pos */
	start_line?: string;
	/** Legacy field: mapped to end */
	end_line?: string;
	/** Legacy field: mapped to lines */
	text?: string;
	/** Legacy field: mapped to lines */
	content?: string;
}

/** Normalize a string anchor: trim, return undefined if empty */
function normalizeAnchor(value: string | undefined | null): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Resolve lines from raw edit, checking lines/text/content fields */
function resolveLines(raw: RawHashlineEdit): string | string[] {
	if (raw.lines !== undefined && raw.lines !== null) return raw.lines;
	if (raw.text !== undefined) return raw.text;
	if (raw.content !== undefined) return raw.content;
	return [];
}

/** Resolve the operation name from op or legacy type field */
function resolveOp(raw: RawHashlineEdit): string {
	if (raw.op) return raw.op;
	if (raw.type) {
		// Map legacy type names to new ops
		switch (raw.type) {
			case "set_line":
				return "replace";
			case "replace_lines":
			case "replace":
				return "replace";
			case "insert_after":
				return "append";
			case "insert_before":
				return "prepend";
			case "append":
				return "append";
			case "prepend":
				return "prepend";
			default:
				return raw.type;
		}
	}
	throw new Error("Missing 'op' field on edit");
}

/** Resolve pos from pos, line, or start_line */
function resolvePos(raw: RawHashlineEdit): string | undefined {
	return normalizeAnchor(raw.pos) ?? normalizeAnchor(raw.line) ?? normalizeAnchor(raw.start_line);
}

/** Resolve end from end or end_line */
function resolveEnd(raw: RawHashlineEdit): string | undefined {
	return normalizeAnchor(raw.end) ?? normalizeAnchor(raw.end_line);
}

function normalizeReplaceEdit(raw: RawHashlineEdit, index: number): ReplaceEdit {
	const pos = resolvePos(raw);
	if (!pos) {
		throw new Error(`Edit ${index}: replace requires at least one anchor line reference (pos or end)`);
	}
	const end = resolveEnd(raw);
	const lines = raw.lines === null ? [] : resolveLines(raw);
	const edit: ReplaceEdit = { op: "replace", pos, lines };
	if (end) edit.end = end;
	return edit;
}

function normalizeAppendEdit(raw: RawHashlineEdit): AppendEdit {
	const pos = resolvePos(raw);
	const lines = raw.lines === null ? [] : resolveLines(raw);
	const edit: AppendEdit = { op: "append", lines };
	if (pos) edit.pos = pos;
	return edit;
}

function normalizePrependEdit(raw: RawHashlineEdit): PrependEdit {
	const pos = resolvePos(raw);
	const lines = raw.lines === null ? [] : resolveLines(raw);
	const edit: PrependEdit = { op: "prepend", lines };
	if (pos) edit.pos = pos;
	return edit;
}

/**
 * Normalize an array of flexible edit objects into typed HashlineEdit objects.
 * Supports legacy field names (type, line, start_line, end_line, text, content)
 * and maps them to the canonical op/pos/end/lines schema.
 */
export function normalizeHashlineEdits(rawEdits: RawHashlineEdit[]): HashlineEdit[] {
	return rawEdits.map((raw, index): HashlineEdit => {
		const op = resolveOp(raw);

		switch (op) {
			case "replace":
				return normalizeReplaceEdit(raw, index);
			case "append":
				return normalizeAppendEdit(raw);
			case "prepend":
				return normalizePrependEdit(raw);
			default:
				throw new Error(`Edit ${index}: unsupported op "${op}". Use op/pos/end/lines format.`);
		}
	});
}
