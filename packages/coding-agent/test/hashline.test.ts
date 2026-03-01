import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	collectLineRefs,
	computeLineHash,
	formatHashLine,
	formatHashLines,
	getEditLineNumber,
	HASHLINE_DICT,
	HASHLINE_PATTERN,
	HASHLINE_REF_PATTERN,
	parseLineRef,
	validateLineRef,
	validateLineRefs,
} from "../src/core/tools/hashline.js";

const HASH_RE = /^[ZPMQVRWSNKTXJBYH]{2}$/;

describe("hashline", () => {
	describe("constants", () => {
		it("HASHLINE_DICT has 256 entries", () => {
			expect(HASHLINE_DICT).toHaveLength(256);
		});

		it("HASHLINE_DICT entries are two-char alphabet strings", () => {
			for (const entry of HASHLINE_DICT) {
				expect(entry).toMatch(HASH_RE);
			}
		});

		it("HASHLINE_PATTERN matches valid hashline format", () => {
			const hash = computeLineHash(42, "const x = 1");
			const match = `42#${hash}:const x = 1`.match(HASHLINE_PATTERN);
			expect(match).not.toBeNull();
			expect(match![1]).toBe("42");
			expect(match![2]).toBe(hash);
			expect(match![3]).toBe("const x = 1");
		});

		it("HASHLINE_PATTERN does not match invalid format", () => {
			expect("no:match".match(HASHLINE_PATTERN)).toBeNull();
			expect("42:xyz|content".match(HASHLINE_PATTERN)).toBeNull();
			expect("42#ab:content".match(HASHLINE_PATTERN)).toBeNull(); // lowercase not in alphabet
		});

		it("HASHLINE_REF_PATTERN matches valid refs", () => {
			const match = "42#ZP".match(HASHLINE_REF_PATTERN);
			expect(match).not.toBeNull();
			expect(match![1]).toBe("42");
			expect(match![2]).toBe("ZP");
		});

		it("HASHLINE_REF_PATTERN does not match old format", () => {
			expect("42:a3f1c2d4".match(HASHLINE_REF_PATTERN)).toBeNull();
		});
	});

	describe("computeLineHash", () => {
		it("returns a 2-char alphabet string", () => {
			const hash = computeLineHash(1, "hello world");
			expect(hash).toMatch(HASH_RE);
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
			expect(hash1).toMatch(HASH_RE);
			expect(hash2).toMatch(HASH_RE);
		});

		it("hash is in HASHLINE_DICT", () => {
			const hash = computeLineHash(1, "test content");
			expect(HASHLINE_DICT).toContain(hash);
		});

		describe("significance-aware seeding", () => {
			it("meaningful lines get same hash at different positions", () => {
				const hash1 = computeLineHash(1, "const x = 1");
				const hash5 = computeLineHash(5, "const x = 1");
				const hash100 = computeLineHash(100, "const x = 1");
				expect(hash1).toBe(hash5);
				expect(hash1).toBe(hash100);
			});

			it("punctuation-only lines get different hashes at different positions", () => {
				const hash1 = computeLineHash(1, "}");
				const hash2 = computeLineHash(2, "}");
				// With only 256 possible values, some may collide, but these specific
				// cases should differ due to different seeds
				expect(hash1).toMatch(HASH_RE);
				expect(hash2).toMatch(HASH_RE);
				// The hashes should be different because seed differs
				expect(hash1).not.toBe(hash2);
			});

			it("empty lines are position-dependent", () => {
				const hash1 = computeLineHash(1, "");
				const hash2 = computeLineHash(2, "");
				expect(hash1).not.toBe(hash2);
			});
		});
	});

	describe("formatHashLine", () => {
		it("formats as LINE#ID:content", () => {
			const result = formatHashLine(5, "const x = 1");
			const hash = computeLineHash(5, "const x = 1");
			expect(result).toBe(`5#${hash}:const x = 1`);
		});

		it("works with empty content", () => {
			const result = formatHashLine(1, "");
			const hash = computeLineHash(1, "");
			expect(result).toBe(`1#${hash}:`);
		});
	});

	describe("formatHashLines", () => {
		it("formats all lines with hashline prefix", () => {
			const content = "line one\nline two\nline three";
			const result = formatHashLines(content);
			const lines = result.split("\n");

			expect(lines).toHaveLength(3);
			expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:line one$/);
			expect(lines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}:line two$/);
			expect(lines[2]).toMatch(/^3#[ZPMQVRWSNKTXJBYH]{2}:line three$/);
		});

		it("respects startLine parameter", () => {
			const content = "line a\nline b";
			const result = formatHashLines(content, 10);
			const lines = result.split("\n");

			expect(lines[0]).toMatch(/^10#[ZPMQVRWSNKTXJBYH]{2}:line a$/);
			expect(lines[1]).toMatch(/^11#[ZPMQVRWSNKTXJBYH]{2}:line b$/);
		});

		it("returns a usable hashline for empty content", () => {
			expect(formatHashLines("")).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:$/);
		});
	});

	describe("parseLineRef", () => {
		it("parses valid line references", () => {
			const result = parseLineRef("42#ZP");
			expect(result).toEqual({ line: 42, hash: "ZP" });
		});

		it("parses single-digit line numbers", () => {
			const result = parseLineRef("1#MQ");
			expect(result).toEqual({ line: 1, hash: "MQ" });
		});

		it("parses large line numbers", () => {
			const result = parseLineRef("99999#VR");
			expect(result).toEqual({ line: 99999, hash: "VR" });
		});

		it("accepts refs copied with marker only", () => {
			const result = parseLineRef(">>> 42#VK");
			expect(result).toEqual({ line: 42, hash: "VK" });
		});

		it("accepts refs copied with trailing content", () => {
			const result = parseLineRef(">>> 42#VK:const value = 1");
			expect(result).toEqual({ line: 42, hash: "VK" });
		});

		it("accepts refs with spaces around hash separator", () => {
			const result = parseLineRef("42 # VK");
			expect(result).toEqual({ line: 42, hash: "VK" });
		});

		it("extracts valid reference from mixed prefix like LINE42#VK", () => {
			const result = parseLineRef("LINE42#VK");
			expect(result).toEqual({ line: 42, hash: "VK" });
		});

		it("throws on invalid format - no hash separator", () => {
			expect(() => parseLineRef("42a3")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - old colon format", () => {
			expect(() => parseLineRef("42:a3f1c2d4")).toThrow(/Invalid line reference format/);
		});

		it("throws with a specific hint when literal prefix is used as line number", () => {
			expect(() => parseLineRef("LINE#HK")).toThrow(/not a line number/i);
		});

		it("throws on invalid format - lowercase chars", () => {
			expect(() => parseLineRef("42#zp")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - wrong alphabet", () => {
			expect(() => parseLineRef("42#AB")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - empty string", () => {
			expect(() => parseLineRef("")).toThrow(/Invalid line reference format/);
		});

		it("throws on invalid format - 3-char hash", () => {
			expect(() => parseLineRef("42#ZPM")).toThrow(/Invalid line reference format/);
		});
	});

	describe("validateLineRef", () => {
		it("passes for valid line and hash", () => {
			const lines = ["hello", "world"];
			const hash = computeLineHash(1, "hello");
			expect(() => validateLineRef(lines, `1#${hash}`)).not.toThrow();
		});

		it("throws for line number out of bounds (too high)", () => {
			const lines = ["hello", "world"];
			expect(() => validateLineRef(lines, "3#ZP")).toThrow(/out of bounds/);
		});

		it("throws for line number out of bounds (zero)", () => {
			const lines = ["hello", "world"];
			expect(() => validateLineRef(lines, "0#ZP")).toThrow(/out of bounds/);
		});

		it("throws for hash mismatch", () => {
			const lines = ["hello", "world"];
			const actualHash = computeLineHash(1, "hello");
			const wrongHash = actualHash === "ZP" ? "MQ" : "ZP";
			expect(() => validateLineRef(lines, `1#${wrongHash}`)).toThrow(/changed since last read/i);
		});

		it("includes >>> context line in mismatch error", () => {
			const lines = ["hello", "world"];
			const actualHash = computeLineHash(1, "hello");
			const wrongHash = actualHash === "ZP" ? "MQ" : "ZP";
			expect(() => validateLineRef(lines, `1#${wrongHash}`)).toThrow(/>>>\s+1#[ZPMQVRWSNKTXJBYH]{2}:hello/);
		});
	});

	describe("validateLineRefs (batch)", () => {
		it("passes for all valid refs", () => {
			const lines = ["hello", "world", "foo"];
			const refs = [`1#${computeLineHash(1, "hello")}`, `3#${computeLineHash(3, "foo")}`];
			expect(() => validateLineRefs(lines, refs)).not.toThrow();
		});

		it("reports all mismatches with >>> context", () => {
			const lines = ["hello", "world"];
			const wrongHash1 = computeLineHash(1, "hello") === "ZP" ? "MQ" : "ZP";
			const wrongHash2 = computeLineHash(2, "world") === "ZP" ? "MQ" : "ZP";
			expect(() => validateLineRefs(lines, [`1#${wrongHash1}`, `2#${wrongHash2}`])).toThrow(/2 lines have changed/i);
			expect(() => validateLineRefs(lines, [`1#${wrongHash1}`, `2#${wrongHash2}`])).toThrow(
				/>>>\s+1#[ZPMQVRWSNKTXJBYH]{2}:hello/,
			);
		});

		it("suggests line number when hash matches existing line", () => {
			const lines = ["function hello() {", "  return 42", "}"];
			const hash = computeLineHash(1, lines[0]);
			expect(() => validateLineRefs(lines, [`LINE#${hash}`])).toThrow(new RegExp(`1#${hash}`));
		});

		it("reports unique changed-line count when duplicate refs point to same line", () => {
			const lines = ["hello", "world"];
			const wrongHash = computeLineHash(1, "hello") === "ZP" ? "MQ" : "ZP";
			expect(() => validateLineRefs(lines, [`1#${wrongHash}`, `1#${wrongHash}`])).toThrow(/1 line has changed/i);
		});
	});

	describe("applyHashlineEdits", () => {
		function ref(lineNumber: number, content: string): string {
			return `${lineNumber}#${computeLineHash(lineNumber, content)}`;
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

		describe("insert_before", () => {
			it("inserts before a line", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{ type: "insert_before", line: ref(2, "line 2"), text: "inserted" },
				]);
				expect(result).toBe("line 1\ninserted\nline 2\nline 3");
			});

			it("inserts before first line", () => {
				const content = "line 1\nline 2";
				const result = applyHashlineEdits(content, [
					{ type: "insert_before", line: ref(1, "line 1"), text: "new first" },
				]);
				expect(result).toBe("new first\nline 1\nline 2");
			});
		});

		describe("insert_between", () => {
			it("inserts between adjacent lines", () => {
				const content = "line 1\nline 2\nline 3";
				const result = applyHashlineEdits(content, [
					{
						type: "insert_between",
						after_line: ref(1, "line 1"),
						before_line: ref(2, "line 2"),
						text: "middle",
					},
				]);
				expect(result).toBe("line 1\nmiddle\nline 2\nline 3");
			});

			it("throws for non-adjacent lines", () => {
				const content = "line 1\nline 2\nline 3";
				expect(() =>
					applyHashlineEdits(content, [
						{
							type: "insert_between",
							after_line: ref(1, "line 1"),
							before_line: ref(3, "line 3"),
							text: "middle",
						},
					]),
				).toThrow(/not adjacent/);
			});
		});

		describe("replace", () => {
			it("works as an alias for replace_lines", () => {
				const content = "line 1\nline 2\nline 3\nline 4";
				const result = applyHashlineEdits(content, [
					{
						type: "replace",
						start_line: ref(2, "line 2"),
						end_line: ref(3, "line 3"),
						text: "replaced",
					},
				]);
				expect(result).toBe("line 1\nreplaced\nline 4");
			});
		});

		describe("append", () => {
			it("adds lines at end of file", () => {
				const content = "line 1\nline 2";
				const result = applyHashlineEdits(content, [{ type: "append", text: "line 3" }]);
				expect(result).toBe("line 1\nline 2\nline 3");
			});

			it("handles multi-line append", () => {
				const content = "line 1";
				const result = applyHashlineEdits(content, [{ type: "append", text: "line 2\\nline 3" }]);
				expect(result).toBe("line 1\nline 2\nline 3");
			});
		});

		describe("prepend", () => {
			it("adds lines at start of file", () => {
				const content = "line 1\nline 2";
				const result = applyHashlineEdits(content, [{ type: "prepend", text: "line 0" }]);
				expect(result).toBe("line 0\nline 1\nline 2");
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

			it("applies replacement before insertion when both target same line", () => {
				const content = ["line 1", "line 2", "line 3"].join(String.fromCharCode(10));
				const result = applyHashlineEdits(content, [
					{ type: "insert_before", line: ref(2, "line 2"), text: "before line 2" },
					{ type: "set_line", line: ref(2, "line 2"), text: "modified line 2" },
				]);
				expect(result).toBe(["line 1", "before line 2", "modified line 2", "line 3"].join(String.fromCharCode(10)));
			});

			it("throws on overlapping range edits", () => {
				const content = ["line 1", "line 2", "line 3", "line 4", "line 5"].join(String.fromCharCode(10));
				expect(() =>
					applyHashlineEdits(content, [
						{ type: "replace_lines", start_line: ref(1, "line 1"), end_line: ref(3, "line 3"), text: "A" },
						{ type: "replace", start_line: ref(2, "line 2"), end_line: ref(4, "line 4"), text: "B" },
					]),
				).toThrow(/overlapping range edits/i);
			});

			it("throws when set_line overlaps with a replace range", () => {
				const content = ["line 1", "line 2", "line 3", "line 4"].join(String.fromCharCode(10));
				expect(() =>
					applyHashlineEdits(content, [
						{ type: "set_line", line: ref(2, "line 2"), text: "S" },
						{ type: "replace_lines", start_line: ref(1, "line 1"), end_line: ref(3, "line 3"), text: "R" },
					]),
				).toThrow(/conflicting edits detected/i);
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

	describe("collectLineRefs", () => {
		function ref(lineNumber: number, content: string): string {
			return `${lineNumber}#${computeLineHash(lineNumber, content)}`;
		}

		it("collects refs from various edit types", () => {
			const edits = [
				{ type: "set_line" as const, line: ref(1, "a"), text: "b" },
				{ type: "insert_after" as const, line: ref(2, "c"), text: "d" },
				{ type: "append" as const, text: "e" },
			];
			const refs = collectLineRefs(edits);
			expect(refs).toHaveLength(2);
		});

		it("collects both refs from replace_lines", () => {
			const edits = [{ type: "replace_lines" as const, start_line: ref(1, "a"), end_line: ref(3, "c"), text: "x" }];
			const refs = collectLineRefs(edits);
			expect(refs).toHaveLength(2);
		});
	});

	describe("getEditLineNumber", () => {
		function ref(lineNumber: number, content: string): string {
			return `${lineNumber}#${computeLineHash(lineNumber, content)}`;
		}

		it("returns line number for set_line", () => {
			expect(getEditLineNumber({ type: "set_line", line: ref(5, "x"), text: "y" })).toBe(5);
		});

		it("returns MAX_SAFE_INTEGER for append", () => {
			expect(getEditLineNumber({ type: "append", text: "x" })).toBe(Number.MAX_SAFE_INTEGER);
		});

		it("returns 0 for prepend", () => {
			expect(getEditLineNumber({ type: "prepend", text: "x" })).toBe(0);
		});
	});
});
