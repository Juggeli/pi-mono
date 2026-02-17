import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bashTool, createBashTool } from "../src/core/tools/bash.js";
import { editTool } from "../src/core/tools/edit.js";
import { findTool } from "../src/core/tools/find.js";
import { grepTool } from "../src/core/tools/grep.js";
import { computeLineHash } from "../src/core/tools/hashline.js";
import { lsTool } from "../src/core/tools/ls.js";
import { readTool } from "../src/core/tools/read.js";
import { writeTool } from "../src/core/tools/write.js";
import * as shellModule from "../src/utils/shell.js";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

/** Compute the LINE:HASH ref for a given line number and content */
function lineRef(lineNumber: number, content: string): string {
	return `${lineNumber}:${computeLineHash(lineNumber, content)}`;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents in LINE:HASH|content format", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });
			const output = getTextOutput(result);

			// Verify hashline format: each line starts with LINE:HASH|
			const lines = output.split("\n");
			expect(lines[0]).toMatch(/^1:[0-9a-f]{2}\|Hello, world!$/);
			expect(lines[1]).toMatch(/^2:[0-9a-f]{2}\|Line 2$/);
			expect(lines[2]).toMatch(/^3:[0-9a-f]{2}\|Line 3$/);
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			// Should have hashline-prefixed lines
			expect(output).toMatch(/^1:[0-9a-f]{2}\|Line 1$/m);
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toMatch(/^1:[0-9a-f]{2}\|Line 1:/m);
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			// Lines should be numbered starting at 51
			expect(output).toMatch(/^51:[0-9a-f]{2}\|Line 51$/m);
			expect(output).toMatch(/^100:[0-9a-f]{2}\|Line 100$/m);
			expect(output).not.toContain("Use offset=");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toMatch(/^1:[0-9a-f]{2}\|Line 1$/m);
			expect(output).toMatch(/^10:[0-9a-f]{2}\|Line 10$/m);
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toMatch(/^41:[0-9a-f]{2}\|Line 41$/m);
			expect(output).toMatch(/^60:[0-9a-f]{2}\|Line 60$/m);
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			// Content should be in hashline format
			expect(output).toMatch(/^1:[0-9a-f]{2}\|definitely not a png$/);
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace a line using set_line", async () => {
			const testFile = join(testDir, "edit-test.txt");
			writeFileSync(testFile, "Hello, world!\nLine 2\nLine 3\n");

			const ref = lineRef(1, "Hello, world!");
			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ type: "set_line", line: ref, text: "Hello, testing!" }],
			});

			expect(getTextOutput(result)).toContain("Successfully applied");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(result.details.diff).toContain("testing");
			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("Hello, testing!\nLine 2\nLine 3\n");
		});

		it("should replace a range using replace_lines", async () => {
			const testFile = join(testDir, "edit-range.txt");
			writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5\n");

			const startRef = lineRef(2, "line 2");
			const endRef = lineRef(4, "line 4");
			const result = await editTool.execute("test-call-range", {
				path: testFile,
				edits: [{ type: "replace_lines", start_line: startRef, end_line: endRef, text: "replaced" }],
			});

			expect(getTextOutput(result)).toContain("Successfully applied");
			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("line 1\nreplaced\nline 5\n");
		});

		it("should insert lines using insert_after", async () => {
			const testFile = join(testDir, "edit-insert.txt");
			writeFileSync(testFile, "line 1\nline 2\nline 3\n");

			const ref = lineRef(2, "line 2");
			const result = await editTool.execute("test-call-insert", {
				path: testFile,
				edits: [{ type: "insert_after", line: ref, text: "inserted line" }],
			});

			expect(getTextOutput(result)).toContain("Successfully applied");
			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("line 1\nline 2\ninserted line\nline 3\n");
		});

		it("should fail on hash mismatch", async () => {
			const testFile = join(testDir, "hash-mismatch.txt");
			writeFileSync(testFile, "actual content\n");

			// Use a wrong hash
			await expect(
				editTool.execute("test-call-mismatch", {
					path: testFile,
					edits: [{ type: "set_line", line: "1:zz", text: "new" }],
				}),
			).rejects.toThrow(/Invalid line reference format/);
		});

		it("should fail on wrong hash value", async () => {
			const testFile = join(testDir, "wrong-hash.txt");
			writeFileSync(testFile, "actual content\n");

			// Compute the actual hash, then use a different valid hash
			const actualHash = computeLineHash(1, "actual content");
			const wrongHash = actualHash === "00" ? "01" : "00";

			await expect(
				editTool.execute("test-call-wrong-hash", {
					path: testFile,
					edits: [{ type: "set_line", line: `1:${wrongHash}`, text: "new" }],
				}),
			).rejects.toThrow(/Hash mismatch/);
		});

		it("should fail if file not found", async () => {
			await expect(
				editTool.execute("test-call-nofile", {
					path: join(testDir, "nonexistent.txt"),
					edits: [{ type: "set_line", line: "1:00", text: "x" }],
				}),
			).rejects.toThrow(/File not found/);
		});

		it("should handle \\n escaping in text", async () => {
			const testFile = join(testDir, "escape-test.txt");
			writeFileSync(testFile, "line 1\nline 2\nline 3\n");

			const ref = lineRef(2, "line 2");
			const result = await editTool.execute("test-call-escape", {
				path: testFile,
				edits: [{ type: "set_line", line: ref, text: "first\\nsecond" }],
			});

			expect(getTextOutput(result)).toContain("Successfully applied");
			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("line 1\nfirst\nsecond\nline 3\n");
		});

		it("should apply multiple edits bottom-up", async () => {
			const testFile = join(testDir, "multi-edit.txt");
			writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\n");

			const ref1 = lineRef(1, "line 1");
			const ref4 = lineRef(4, "line 4");
			const result = await editTool.execute("test-call-multi", {
				path: testFile,
				edits: [
					{ type: "set_line", line: ref1, text: "FIRST" },
					{ type: "set_line", line: ref4, text: "FOURTH" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully applied 2 edit(s)");
			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("FIRST\nline 2\nline 3\nFOURTH\n");
		});
	});

	describe("edit tool CRLF handling", () => {
		it("should preserve CRLF line endings after edit", async () => {
			const testFile = join(testDir, "crlf-preserve.txt");
			writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

			// Hash is computed on LF-normalized content
			const ref = lineRef(2, "second");

			await editTool.execute("test-crlf-1", {
				path: testFile,
				edits: [{ type: "set_line", line: ref, text: "REPLACED" }],
			});

			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
		});

		it("should preserve LF line endings for LF files", async () => {
			const testFile = join(testDir, "lf-preserve.txt");
			writeFileSync(testFile, "first\nsecond\nthird\n");

			const ref = lineRef(2, "second");

			await editTool.execute("test-lf-1", {
				path: testFile,
				edits: [{ type: "set_line", line: ref, text: "REPLACED" }],
			});

			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("first\nREPLACED\nthird\n");
		});

		it("should preserve UTF-8 BOM after edit", async () => {
			const testFile = join(testDir, "bom-test.txt");
			writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

			const ref = lineRef(2, "second");

			await editTool.execute("test-bom", {
				path: testFile,
				edits: [{ type: "set_line", line: ref, text: "REPLACED" }],
			});

			const content = readFileSync(testFile, "utf-8");
			expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it("should respect timeout", async () => {
			await expect(bashTool.execute("test-call-10", { command: "sleep 5", timeout: 1 })).rejects.toThrow(
				/timed out/i,
			);
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});
	});

	describe("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});
	});

	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});
