import { describe, expect, it } from "vitest";
import { resolveTools } from "../tool-restrictions.js";
import { createLibrarianAgent } from "./librarian.js";

describe("createLibrarianAgent", () => {
	it("enforces read-only bash policy", () => {
		const agent = createLibrarianAgent();
		expect(agent.bashPolicy).toBe("read-only");
	});

	it("blocks destructive bash commands", async () => {
		const agent = createLibrarianAgent();
		const tools = resolveTools(process.cwd(), agent.tools, agent.bashPolicy);
		const bashTool = tools.find((tool) => tool.name === "bash");
		if (!bashTool) throw new Error("bash tool was not resolved");

		await expect(bashTool.execute("test", { command: "touch /tmp/librarian-should-not-write" })).rejects.toThrow(
			"Command blocked by read-only bash policy",
		);
	});

	it("allows read-only bash commands", async () => {
		const agent = createLibrarianAgent();
		const tools = resolveTools(process.cwd(), agent.tools, agent.bashPolicy);
		const bashTool = tools.find((tool) => tool.name === "bash");
		if (!bashTool) throw new Error("bash tool was not resolved");

		await expect(bashTool.execute("test", { command: "pwd" })).resolves.toBeDefined();
	});
});
