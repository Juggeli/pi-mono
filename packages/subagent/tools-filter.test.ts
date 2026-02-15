import { describe, it, expect } from "vitest";
import { filterSubagentTools } from "./tools-filter.js";

describe("filterSubagentTools", () => {
	it("returns empty array when tools is undefined", () => {
		expect(filterSubagentTools(undefined)).toEqual([]);
	});

	it("returns empty array when tools is empty", () => {
		expect(filterSubagentTools([])).toEqual([]);
	});

	it("filters out 'subagent' from tools list", () => {
		const tools = ["read", "subagent", "grep", "find"];
		expect(filterSubagentTools(tools)).toEqual(["read", "grep", "find"]);
	});

	it("returns all tools when 'subagent' is not present", () => {
		const tools = ["read", "grep", "find", "bash"];
		expect(filterSubagentTools(tools)).toEqual(["read", "grep", "find", "bash"]);
	});

	it("returns empty array when only tool is 'subagent'", () => {
		expect(filterSubagentTools(["subagent"])).toEqual([]);
	});

	it("handles multiple 'subagent' occurrences", () => {
		const tools = ["subagent", "read", "subagent", "grep", "subagent"];
		expect(filterSubagentTools(tools)).toEqual(["read", "grep"]);
	});

	it("preserves order of remaining tools", () => {
		const tools = ["subagent", "read", "subagent", "grep", "subagent", "find"];
		expect(filterSubagentTools(tools)).toEqual(["read", "grep", "find"]);
	});
});
