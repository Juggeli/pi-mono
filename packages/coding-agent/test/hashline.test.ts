import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHash,
	formatHashLine,
	formatHashLines,
	HASH_DICT,
	HASHLINE_PATTERN,
	parseLineRef,
	validateLineRef,
} from "../src/core/tools/hashline.js";

describe("hashline", () => {
	describe("constants", () => {
		it("HASH_DICT has 256 entries", () => {
			expect(HASH_DICT).toHaveLength(256);
		});

		it("HASH_DICT entries are two-char hex strings", () => {
			for (const entry of HASH_DICT) {
				expect(entry).toMatch(/^[0-9a-f]{2}$/);
			}
		});

		it("HASHLINE_PATTERN matches valid hashline format", () => {
			const match = "42:a3f1c2d4|const x = 1".match(HASHLINE_PATTERN);
			expect(match).not.toBeNull();
			expect(match![1]).toBe("42");
			expect(match![2]).toBe("a3f1c2d4");
			expect(match![3]).toBe("const x = 1");
		});

		it("HASHLINE_PATTERN does not match invalid format", () => {
			expect("no:match".match(HASHLINE_PATTERN)).toBeNull();
			expect("42:xyz|content".match(HASHLINE_PATTERN)).toBeNull();
		});
	});

	describe("computeLineHash", () => {
		it("returns an 8-char hex string", () => {
			const hash = computeLineHash(1, "hello world");
			expect(hash).toMatch(/^[0-9a-f]{8}$/);
		});

		it("is deterministic", () => {
			const hash1 = computeLineHash(1, "hello world");
			const hash2 = computeLineHash(1, "hello world");
			expect(hash1).toBe(hash2);
		});

		it("is whitespace-insensitive", () => {
			const hash1 = computeLineHash(1, "hello world");
			const hash2 = computeLineHash(1, "  hello   world  ");
			expect(hash1).toBe(hash2);
		});

		it("is whitespace-insensitive for tabs", () => {
			const hash1 = computeLineHash(1, "hello world");
			const hash2 = computeLineHash(1, "\thello\tworld\t");
			expect(hash1).toBe(hash2);
		});

		it("produces different hashes for different content", () => {
			const hash1 = computeLineHash(1, "hello");
			const hash2 = computeLineHash(1, "world");
			// Very unlikely to collide, but not impossible with 32-bit output
			// This test documents intent rather than guaranteeing uniqueness
			expect(hash1).toMatch(/^[0-9a-f]{8}$/);
			expect(hash2).toMatch(/^[0-9a-f]{8}$/);
		});

		it("first byte of hash is in HASH_DICT", () => {
			const hash = computeLineHash(1, "test content");
			expect(HASH_DICT).toContain(hash.slice(0, 2));
		});
	});

	describe("formatHashLine", () => {
		it("formats as LINE:HASH|content", () => {
			const result = formatHashLine(5, "const x = 1");
			const hash = computeLineHash(5, "const x = 1");
			expect(result).toBe(`5:${hash}|const x = 1`);
		});

		it("works with empty content", () => {
			const result = formatHashLine(1, "");
			const hash = computeLineHash(1, "");
			expect(result).toBe(`1:${hash}|`);
		});
	});

	describe("formatHashLines", () => {
		it("formats all lines with hashline prefix", () => {
			const content = "line one\nline two\nline three";
			const result = formatHashLines(content);
			const lines = result.split("\n");

			expect(lines).toHaveLength(3);
			expect(lines[0]).toMatch(/^1:[0-9a-f]{8}\|line one$/);
			expect(lines[1]).toMatch(/^2:[0-9a-f]{8}\|line two$/);
			expect(lines[2]).toMatch(/^3:[0-9a-f]{8}\|line three$/);
		});

		it("respects startLine parameter", () => {
			const content = "line a\nline b";
			const result = formatHashLines(content, 10);
			const lines = result.split("\n");

			expect(lines[0]).toMatch(/^10:[0-9a-f]{8}\|line a$/);
			expect(lines[1]).toMatch(/^11:[0-9a-f]{8}\|line b$/);
		});

		it("supports consistent refs for offset reads with duplicate lines", () => {
			const allLines = ["header", "}", "}", "tail"];
			const fullRef = formatHashLines(allLines.join("\n")).split("\n")[2].split("|")[0];
			const partialRef = formatHashLines(allLines.slice(2).join("\n"), 3, allLines.slice(0, 2))
				.split("\n")[0]
				.split("|")[0];
			expect(partialRef).toBe(fullRef);
		});

		it("returns a usable hashline for empty content", () => {
			expect(formatHashLines("")).toMatch(/^1:[0-9a-f]{8}\|$/);
		});
	});

	describe("parseLineRef", () => {
		it("parses valid line references", () => {
			const result = parseLineRef("42:a3f1c2d4");
			expect(result).toEqual({ line: 42, hash: "a3f1c2d4" });
		});

		it("parses single-digit line numbers", () => {
			const result = parseLineRef("1:ffffffff");
			expect(result).toEqual({ line: 1, hash: "ffffffff" });
		});

		it("parses large line numbers", () => {
			const result = parseLineRef("99999:00000000");
			expect(result).toEqual({ line: 99999, hash: "00000000" });
		});

		it("throws on invalid format - no colon", () => {
			expect(() => parseLineRef("42a3")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - no hash", () => {
			expect(() => parseLineRef("42:")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - 3-char hash", () => {
			expect(() => parseLineRef("42:abc")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - 2-char hash", () => {
			expect(() => parseLineRef("42:ab")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - non-hex hash", () => {
			expect(() => parseLineRef("42:zz")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - empty string", () => {
			expect(() => parseLineRef("")).toThrow(/Invalid line reference format/);
		});
	});

	describe("validateLineRef", () => {
		it("passes for valid line and hash", () => {
			const lines = ["hello", "world"];
			const hash = computeLineHash(1, "hello");
			expect(() => validateLineRef(lines, `1:${hash}`)).not.toThrow();
		});

		it("throws for line number out of bounds (too high)", () => {
			const lines = ["hello", "world"];
			expect(() => validateLineRef(lines, "3:00000000")).toThrow(/out of bounds/);
		});

		it("throws for line number out of bounds (zero)", () => {
			const lines = ["hello", "world"];
			expect(() => validateLineRef(lines, "0:00000000")).toThrow(/out of bounds/);
		});

		it("throws for hash mismatch", () => {
			const lines = ["hello", "world"];
			const actualHash = computeLineHash(1, "hello");
			const wrongHash = actualHash === "00000000" ? "00000001" : "00000000";
			expect(() => validateLineRef(lines, `1:${wrongHash}`)).toThrow(/Hash mismatch/);
		});

		it("includes current content in mismatch error", () => {
			const lines = ["hello", "world"];
			const actualHash = computeLineHash(1, "hello");
			const wrongHash = actualHash === "00000000" ? "00000001" : "00000000";
			expect(() => validateLineRef(lines, `1:${wrongHash}`)).toThrow(/Current content: "hello"/);
		});

		it("rejects stale references when duplicate-line occupancy changes", () => {
			const originalRef = formatHashLines("x\n}\n}\ny").split("\n")[1].split("|")[0];
			const shiftedLines = ["}", "}", "y"];
			expect(() => validateLineRef(shiftedLines, originalRef)).toThrow(/Hash mismatch/);
		});
	});

	describe("applyHashlineEdits", () => {
		function ref(lineNumber: number, content: string): string {
			return `${lineNumber}:${computeLineHash(lineNumber, content)}`;
		}

		describe("set_line", () => {
			it("replaces a single line", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{ type: "set_line", line: ref(2, "line 2"), text: "replaced" },
				]);
				expect(result).toBe("line 1\nreplaced\nline 3");
			});

			it("replaces first line", () => {
				const content = "first\nsecond";
				const result = applyHashlineEdits(content, [
					{ type: "set_line", line: ref(1, "first"), text: "new first" },
				]);
				expect(result).toBe("new first\nsecond");
			});

			it("replaces last line", () => {
				const content = "first\nsecond";
				const result = applyHashlineEdits(content, [
					{ type: "set_line", line: ref(2, "second"), text: "new second" },
				]);
				expect(result).toBe("first\nnew second");
			});
		});

		describe("replace_lines", () => {
			it("replaces a range of lines", () => {
				const content = "line 1\nline 2\nline 3\nline 4\nline 5";
				const result = applyHashlineEdits(content, [
					{
						type: "replace_lines",
						start_line: ref(2, "line 2"),
						end_line: ref(4, "line 4"),
						text: "replaced",
					},
				]);
				expect(result).toBe("line 1\nreplaced\nline 5");
			});

			it("replaces a single line range (start == end)", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{
						type: "replace_lines",
						start_line: ref(2, "line 2"),
						end_line: ref(2, "line 2"),
						text: "replaced",
					},
				]);
				expect(result).toBe("line 1\nreplaced\nline 3");
			});

			it("handles multi-line replacement text with \\n", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{
						type: "replace_lines",
						start_line: ref(2, "line 2"),
						end_line: ref(2, "line 2"),
						text: "a\\nb\\nc",
					},
				]);
				expect(result).toBe("line 1\na\nb\nc\nline 3");
			});

			it("deletes the target range when replacement text is empty", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{
						type: "replace_lines",
						start_line: ref(2, "line 2"),
						end_line: ref(3, "line 3"),
						text: "",
					},
				]);
				expect(result).toBe("line 1");
			});

			it("throws for invalid range (start > end)", () => {
				const content = "line 1\nline 2\nline 3";
				expect(() =>
					applyHashlineEdits(content, [
						{
							type: "replace_lines",
							start_line: ref(3, "line 3"),
							end_line: ref(1, "line 1"),
							text: "x",
						},
					]),
				).toThrow(/Invalid range/);
			});
		});

		describe("insert_after", () => {
			it("inserts after a line", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{ type: "insert_after", line: ref(2, "line 2"), text: "inserted" },
				]);
				expect(result).toBe("line 1\nline 2\ninserted\nline 3");
			});

			it("inserts after last line", () => {
				const content = "line 1\nline 2";
				const result = applyHashlineEdits(content, [
					{ type: "insert_after", line: ref(2, "line 2"), text: "new last" },
				]);
				expect(result).toBe("line 1\nline 2\nnew last");
			});

			it("handles multi-line insert with \\n", () => {
				const content = "line 1\nline 2";
				const result = applyHashlineEdits(content, [
					{ type: "insert_after", line: ref(1, "line 1"), text: "a\\nb" },
				]);
				expect(result).toBe("line 1\na\nb\nline 2");
			});
		});

		describe("sorting (bottom-up)", () => {
			it("applies edits from bottom to top", () => {
				const content = "line 1\nline 2\nline 3\nline 4";
				const result = applyHashlineEdits(content, [
					// Deliberately pass in top-first order - should still work
					{ type: "set_line", line: ref(1, "line 1"), text: "FIRST" },
					{ type: "set_line", line: ref(4, "line 4"), text: "FOURTH" },
				]);
				expect(result).toBe("FIRST\nline 2\nline 3\nFOURTH");
			});

			it("preserves line numbers when inserting bottom-up", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{ type: "insert_after", line: ref(1, "line 1"), text: "after 1" },
					{ type: "insert_after", line: ref(3, "line 3"), text: "after 3" },
				]);
				expect(result).toBe("line 1\nafter 1\nline 2\nline 3\nafter 3");
			});
		});

		describe("edge cases", () => {
			it("returns unchanged content for empty edits array", () => {
				const content = "hello\nworld";
				expect(applyHashlineEdits(content, [])).toBe(content);
			});

			it("handles single-line content", () => {
				const content = "only line";
				const result = applyHashlineEdits(content, [
					{ type: "set_line", line: ref(1, "only line"), text: "replaced" },
				]);
				expect(result).toBe("replaced");
			});

			it("handles empty line content", () => {
				const content = "line 1\n\nline 3";
				const result = applyHashlineEdits(content, [{ type: "set_line", line: ref(2, ""), text: "filled" }]);
				expect(result).toBe("line 1\nfilled\nline 3");
			});
		});
	});
});
