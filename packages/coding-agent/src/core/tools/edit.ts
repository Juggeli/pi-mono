import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { dedupeEdits } from "./edit-deduplication.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { applyHashlineEdits } from "./hashline.js";
import { normalizeHashlineEdits, type RawHashlineEdit } from "./normalize-edits.js";
import { resolveToCwd } from "./path-utils.js";

const EditOperationSchema = Type.Object({
	type: Type.String({
		description:
			"Edit type: set_line, replace_lines, insert_after, insert_before, insert_between, replace, append, prepend",
	}),
	line: Type.Optional(Type.String({ description: 'Line reference in LINE#ID format (e.g., "5#ZP")' })),
	start_line: Type.Optional(Type.String({ description: "Start line in LINE#ID format" })),
	end_line: Type.Optional(Type.String({ description: "End line in LINE#ID format" })),
	after_line: Type.Optional(Type.String({ description: "After line in LINE#ID format (for insert_between)" })),
	before_line: Type.Optional(Type.String({ description: "Before line in LINE#ID format (for insert_between)" })),
	text: Type.Optional(Type.String({ description: "New content (use \\n for newlines)" })),
	content: Type.Optional(Type.String({ description: "Alias for text" })),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(EditOperationSchema, {
		description: "Array of edit operations to apply",
	}),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (e.g., SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	const ops = options?.operations ?? defaultEditOperations;

	return {
		name: "edit",
		label: "edit",
		description: `Edit files using LINE#ID references for precise, safe modifications.

LINE#ID FORMAT:
Each line reference must be in "LINE#ID" format where:
- LINE: 1-based line number
- ID: 2-character identifier from the hashline alphabet
- Example: "5#ZP" means line 5 with ID "ZP"

GETTING IDs:
Use the read tool first - it returns lines in "LINE#ID:content" format.

EIGHT OPERATION TYPES:

1. set_line: Replace a single line
   { "type": "set_line", "line": "5#ZP", "text": "const y = 2" }

2. replace_lines: Replace a range of lines (inclusive)
   { "type": "replace_lines", "start_line": "5#ZP", "end_line": "7#VR", "text": "new\\ncontent" }
   { "type": "replace_lines", "start_line": "5#ZP", "end_line": "7#VR", "text": "" } // deletes lines 5-7

3. insert_after: Insert new lines after a specific line
   { "type": "insert_after", "line": "5#ZP", "text": "console.log('hi')" }

4. insert_before: Insert new lines before a specific line
   { "type": "insert_before", "line": "5#ZP", "text": "// comment" }

5. insert_between: Insert between two adjacent lines
   { "type": "insert_between", "after_line": "5#ZP", "before_line": "6#VR", "text": "middle" }

6. replace: Same as replace_lines (alias)
   { "type": "replace", "start_line": "5#ZP", "end_line": "7#VR", "text": "new content" }

7. append: Add lines at end of file
   { "type": "append", "text": "// end of file" }

8. prepend: Add lines at start of file
   { "type": "prepend", "text": "// header" }

HASH MISMATCH HANDLING:
If the ID doesn't match the current content, the edit fails with a clear error showing the corrected ref.
Re-read the file to get updated IDs.

BOTTOM-UP APPLICATION:
Edits are automatically sorted and applied from bottom to top (highest line numbers first) to preserve line number references.

ESCAPING:
Use \\n in text fields to represent literal newlines (for multi-line replacements/insertions).`,
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, edits }: { path: string; edits: RawHashlineEdit[] },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);

			return new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: EditToolDetails | undefined;
			}>((resolve, reject) => {
				// Check if already aborted
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;

				// Set up abort handler
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
				}

				// Perform the edit operation
				(async () => {
					try {
						// Check if file exists
						try {
							await ops.access(absolutePath);
						} catch {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(new Error(`File not found: ${path}`));
							return;
						}

						// Check if aborted before reading
						if (aborted) {
							return;
						}

						// Normalize flexible edit input to typed edits
						const normalizedEdits = normalizeHashlineEdits(edits);

						// Deduplicate
						const { edits: uniqueEdits, duplicatesRemoved } = dedupeEdits(normalizedEdits);

						if (uniqueEdits.length === 0) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							resolve({
								content: [{ type: "text", text: `No edits to apply to ${path}.` }],
								details: undefined,
							});
							return;
						}

						// Read the file
						const buffer = await ops.readFile(absolutePath);
						const rawContent = buffer.toString("utf-8");

						// Check if aborted after reading
						if (aborted) {
							return;
						}

						// Strip BOM before matching
						const { bom, text: content } = stripBom(rawContent);

						const originalEnding = detectLineEnding(content);
						const normalizedContent = normalizeToLF(content);

						// Apply hashline edits
						const newContent = applyHashlineEdits(normalizedContent, uniqueEdits);

						// Verify the replacement actually changed something
						if (normalizedContent === newContent) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							resolve({
								content: [
									{
										type: "text",
										text: `No changes resulted from ${uniqueEdits.length} edit(s) to ${path}. The edits produced identical content.`,
									},
								],
								details: undefined,
							});
							return;
						}

						// Check if aborted before writing
						if (aborted) {
							return;
						}

						const finalContent = bom + restoreLineEndings(newContent, originalEnding);
						await ops.writeFile(absolutePath, finalContent);

						// Check if aborted after writing
						if (aborted) {
							return;
						}

						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						const diffResult = generateDiffString(normalizedContent, newContent);
						const dupeNote = duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicate(s) removed)` : "";
						resolve({
							content: [
								{
									type: "text",
									text: `Updated ${path}${dupeNote}`,
								},
							],
							details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
						});
					} catch (error: any) {
						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						if (!aborted) {
							reject(error);
						}
					}
				})();
			});
		},
	};
}

/** Default edit tool using process.cwd() - for backwards compatibility */
export const editTool = createEditTool(process.cwd());
