import { describe, expect, it } from "vitest";
import { createReadOnlyBashTool, validateReadOnlyBashCommand } from "./read-only-bash.js";

describe("validateReadOnlyBashCommand", () => {
	it("allows read-only git commands", () => {
		expect(validateReadOnlyBashCommand("git log --oneline -n 5")).toEqual({ allowed: true });
		expect(validateReadOnlyBashCommand("git blame packages/coding-agent/src/main.ts")).toEqual({ allowed: true });
		expect(validateReadOnlyBashCommand("git config --get remote.origin.url")).toEqual({ allowed: true });
	});

	it("blocks command chaining", () => {
		const result = validateReadOnlyBashCommand("git status; touch /tmp/pwned");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("chaining");
	});

	it("blocks redirection", () => {
		const result = validateReadOnlyBashCommand("echo hello > /tmp/out.txt");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("destructive");
	});

	it("blocks git write commands", () => {
		const result = validateReadOnlyBashCommand("git commit -m 'nope'");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("destructive");
	});

	it("blocks commands not on the allowlist", () => {
		const result = validateReadOnlyBashCommand("python -c 'print(1)'");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("allowlist");
	});
});

describe("createReadOnlyBashTool", () => {
	it("rejects blocked commands before execution", async () => {
		const tool = createReadOnlyBashTool(process.cwd());
		await expect(tool.execute("test", { command: "echo hello > /tmp/read-only-bash-test.txt" })).rejects.toThrow(
			"Command blocked by read-only bash policy",
		);
	});
});
