import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import {
	access as fsAccess,
	readFile as fsReadFile,
	rename as fsRename,
	unlink as fsUnlink,
	writeFile as fsWriteFile,
} from "fs/promises";
import { dedupeEdits } from "./edit-deduplication.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { applyHashlineEdits, HashlineMismatchError } from "./hashline.js";
import { normalizeHashlineEdits, type RawHashlineEdit } from "./normalize-edits.js";
import { resolveToCwd } from "./path-utils.js";

const EditOperationSchema = Type.Object({
	op: Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("prepend")], {
		description: 'Operation type: "replace", "append", or "prepend"',
	}),
	pos: Type.Optional(Type.String({ description: 'Line reference in LINE#ID format (e.g., "5#ZP")' })),
	end: Type.Optional(Type.String({ description: "End line reference in LINE#ID format (for range replace)" })),
	lines: Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()], {
		description: "New content: string, string[], or null (for deletion)",
	}),
});

const editSchema = Type.Object({
	filePath: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(EditOperationSchema, {
		description: "Array of edit operations to apply",
	}),
	delete: Type.Optional(Type.Boolean({ description: "If true, delete the file instead of editing it" })),
	rename: Type.Optional(Type.String({ description: "New path to rename the file to" })),
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
	/** Delete a file */
	unlink?: (absolutePath: string) => Promise<void>;
	/** Rename a file */
	rename?: (oldPath: string, newPath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
	unlink: (path) => fsUnlink(path),
	rename: (oldPath, newPath) => fsRename(oldPath, newPath),
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
Use the read tool first - it returns lines in "LINE#ID|content" format.

THREE OPERATION TYPES:

1. replace: Replace line(s)
   Single line: { "op": "replace", "pos": "5#ZP", "lines": "const y = 2" }
   Range: { "op": "replace", "pos": "5#ZP", "end": "7#VR", "lines": "new\\ncontent" }
   Delete range: { "op": "replace", "pos": "5#ZP", "end": "7#VR", "lines": null }

2. append: Insert after a line, or at end of file
   After line: { "op": "append", "pos": "5#ZP", "lines": "console.log('hi')" }
   End of file: { "op": "append", "lines": "// end of file" }

3. prepend: Insert before a line, or at start of file
   Before line: { "op": "prepend", "pos": "5#ZP", "lines": "// comment" }
   Start of file: { "op": "prepend", "lines": "// header" }

FILE OPERATIONS:
Delete file: { "filePath": "path/to/file", "edits": [], "delete": true }
Rename file: { "filePath": "path/to/file", "edits": [], "rename": "new/path" }

HASH MISMATCH HANDLING:
If the ID doesn't match the current content, the edit fails with a clear error showing the corrected ref.
Re-read the file to get updated IDs.

BOTTOM-UP APPLICATION:
Edits are automatically sorted and applied from bottom to top (highest line numbers first) to preserve line number references.

ESCAPING:
Use \\n in string lines fields to represent literal newlines (for multi-line replacements/insertions).
Or pass lines as an array of strings for multi-line content.`,
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			input: { filePath: string; edits: RawHashlineEdit[]; delete?: boolean; rename?: string },
			signal?: AbortSignal,
		) => {
			// Support both filePath and legacy path field
			const path = input.filePath ?? (input as any).path;
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
						// Validate invalid combinations
						if (input.delete && input.rename) {
							throw new Error("delete and rename cannot be used together");
						}
						if (input.delete && input.edits && input.edits.length > 0) {
							throw new Error("delete mode requires edits to be an empty array");
						}

						// Handle delete
						if (input.delete) {
							if (ops.unlink) {
								await ops.unlink(absolutePath);
							} else {
								throw new Error("Delete operation not supported");
							}
							if (signal) signal.removeEventListener("abort", onAbort);
							resolve({
								content: [{ type: "text", text: `Deleted ${path}` }],
								details: undefined,
							});
							return;
						}

						// Normalize flexible edit input to typed edits
						const normalizedEdits = normalizeHashlineEdits(input.edits);

						// Deduplicate
						const { edits: uniqueEdits, duplicatesRemoved } = dedupeEdits(normalizedEdits);

						if (uniqueEdits.length === 0) {
							// Rename-only (no edits)
							if (input.rename) {
								const newAbsolutePath = resolveToCwd(input.rename, cwd);
								if (ops.rename) {
									await ops.rename(absolutePath, newAbsolutePath);
								} else {
									throw new Error("Rename operation not supported");
								}
								if (signal) signal.removeEventListener("abort", onAbort);
								resolve({
									content: [{ type: "text", text: `Renamed ${path} to ${input.rename}` }],
									details: undefined,
								});
								return;
							}
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							resolve({
								content: [{ type: "text", text: `No edits to apply to ${path}.` }],
								details: undefined,
							});
							return;
						}

						const canCreateFromMissingFile =
							uniqueEdits.length > 0 &&
							uniqueEdits.every((edit) => (edit.op === "append" || edit.op === "prepend") && !edit.pos);

						// Check if file exists or if we can create it from append/prepend edits
						let fileExists = true;
						try {
							await ops.access(absolutePath);
						} catch {
							fileExists = false;
						}

						if (!fileExists && !canCreateFromMissingFile) {
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

						// Read file if it exists, otherwise start from empty content
						const buffer = fileExists ? await ops.readFile(absolutePath) : Buffer.from("");
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
						const { content: newContent, noopEdits } = applyHashlineEdits(normalizedContent, uniqueEdits);

						// Verify the replacement actually changed something
						if (normalizedContent === newContent && !input.rename) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
							if (noopEdits > 0) {
								diagnostic += ` No-op edits: ${noopEdits}. Re-read the file and provide content that differs from current lines.`;
							}
							resolve({
								content: [
									{
										type: "text",
										text: diagnostic,
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

						// Handle rename after edits (write edited content, then move)
						if (input.rename && input.rename !== path) {
							const newAbsolutePath = resolveToCwd(input.rename, cwd);
							if (ops.rename) {
								await ops.rename(absolutePath, newAbsolutePath);
							} else {
								throw new Error("Rename operation not supported");
							}
						}

						// Check if aborted after writing
						if (aborted) {
							return;
						}

						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						const effectivePath = input.rename && input.rename !== path ? input.rename : path;
						const diffResult = generateDiffString(normalizedContent, newContent);
						const dupeNote = duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicate(s) removed)` : "";
						resolve({
							content: [
								{
									type: "text",
									text: `Updated ${effectivePath}${dupeNote}`,
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
							if (error instanceof HashlineMismatchError) {
								const message = error instanceof Error ? error.message : String(error);
								reject(
									new Error(
										`${message}\nTip: reuse LINE#ID entries from the latest read/edit output, or batch related edits in one call.`,
									),
								);
							} else {
								reject(error);
							}
						}
					}
				})();
			});
		},
	};
}

/** Default edit tool using process.cwd() - for backwards compatibility */
export const editTool = createEditTool(process.cwd());
