import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { applyHashlineEdits, type HashlineEdit } from "./hashline.js";
import { resolveToCwd } from "./path-utils.js";

const SetLineSchema = Type.Object({
	type: Type.Literal("set_line"),
	line: Type.String({ description: 'Line reference in LINE:HASH format (e.g., "5:a3")' }),
	text: Type.String({ description: "New content for the line" }),
});

const ReplaceLinesSchema = Type.Object({
	type: Type.Literal("replace_lines"),
	start_line: Type.String({ description: "Start line in LINE:HASH format" }),
	end_line: Type.String({ description: "End line in LINE:HASH format" }),
	text: Type.String({ description: "New content to replace the range (use \\n for newlines)" }),
});

const InsertAfterSchema = Type.Object({
	type: Type.Literal("insert_after"),
	line: Type.String({ description: "Line reference in LINE:HASH format" }),
	text: Type.String({ description: "Content to insert after the line (use \\n for newlines)" }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(Type.Union([SetLineSchema, ReplaceLinesSchema, InsertAfterSchema]), {
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
		description: `Edit files using LINE:HASH references for precise, safe modifications.

LINE:HASH FORMAT:
Each line reference must be in "LINE:HASH" format where:
- LINE: 1-based line number
- HASH: 2-character hex hash of line content
- Example: "5:a3" means line 5 with hash "a3"

GETTING HASHES:
Use the read tool first - it returns lines in "LINE:HASH|content" format.

THREE OPERATION TYPES:

1. set_line: Replace a single line
   { "type": "set_line", "line": "5:a3", "text": "const y = 2" }

2. replace_lines: Replace a range of lines (inclusive)
   { "type": "replace_lines", "start_line": "5:a3", "end_line": "7:b2", "text": "new\\ncontent" }

3. insert_after: Insert new lines after a specific line
   { "type": "insert_after", "line": "5:a3", "text": "console.log('hi')" }

HASH MISMATCH HANDLING:
If the hash doesn't match the current content, the edit fails with a clear error showing current hash.
Re-read the file to get updated hashes.

BOTTOM-UP APPLICATION:
Edits are automatically sorted and applied from bottom to top (highest line numbers first) to preserve line number references.

ESCAPING:
Use \\n in text fields to represent literal newlines (for multi-line replacements/insertions).`,
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, edits }: { path: string; edits: HashlineEdit[] },
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
						const newContent = applyHashlineEdits(normalizedContent, edits);

						// Verify the replacement actually changed something
						if (normalizedContent === newContent) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(new Error(`No changes made to ${path}. The edits produced identical content.`));
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
						resolve({
							content: [
								{
									type: "text",
									text: `Successfully applied ${edits.length} edit(s) to ${path}.`,
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
