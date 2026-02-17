import { beforeEach, describe, expect, it, vi } from "vitest";
import askUserExtension from "../built-in-extensions/ask-user.js";

// Mock dependencies
vi.mock("@mariozechner/pi-tui", () => ({
	Editor: vi.fn(),
	Key: {},
	matchesKey: vi.fn(),
	Text: vi.fn().mockImplementation((text: string, _x: number, _y: number) => ({
		text,
	})),
	truncateToWidth: vi.fn((s: string) => s),
}));

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: {
		cancelled: boolean;
		selected: string[];
		multi: boolean;
		question?: string;
		options?: string[];
		custom_input?: string;
	};
}

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<ToolResult>;
	renderCall: (...args: unknown[]) => { text: string };
	renderResult: (...args: unknown[]) => { text: string };
}

describe("ask_user extension", () => {
	let mockRegisterTool: any;
	let registeredTool: RegisteredTool;

	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterTool = vi.fn((tool: RegisteredTool) => {
			registeredTool = tool;
		});

		const mockPi = {
			registerTool: mockRegisterTool,
		};

		askUserExtension(mockPi as unknown as Parameters<typeof askUserExtension>[0]);
	});

	describe("tool registration", () => {
		it("registers with correct name and label", () => {
			expect(registeredTool.name).toBe("ask_user");
			expect(registeredTool.label).toBe("Ask User");
		});

		it("has a description", () => {
			expect(registeredTool.description).toContain("Ask the user a question");
			expect(registeredTool.description).toContain("multi");
			expect(registeredTool.description).toContain("recommended");
		});
	});

	describe("schema validation", () => {
		it("has a schema with expected structure", () => {
			// The actual schema is defined in the implementation
			// We verify it's used by checking tool registration
			expect(registeredTool.parameters).toBeDefined();
			expect(registeredTool.parameters).toHaveProperty("type", "object");
			expect(registeredTool.parameters).toHaveProperty("properties");
			const props = (registeredTool.parameters as { properties: Record<string, unknown> }).properties;
			expect(props).toHaveProperty("question");
			expect(props).toHaveProperty("options");
			expect(props).toHaveProperty("multi");
			expect(props).toHaveProperty("allow_other");
			expect(props).toHaveProperty("recommended");
		});
	});

	describe("execute - validation", () => {
		it("returns error when options is empty", async () => {
			// Pass a valid context with UI so the empty options check runs first
			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Test?",
					options: [],
					multi: false,
					allow_other: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: vi.fn(),
						input: vi.fn(),
						custom: vi.fn(),
					},
				},
			);

			expect(result.content[0]).toEqual({
				type: "text",
				text: "Error: options must not be empty",
			});
			expect(result.details.cancelled).toBe(true);
		});

		it("returns error in headless mode (no UI)", async () => {
			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Test?",
					options: [{ label: "A" }],
					multi: false,
					allow_other: true,
				},
				undefined,
				undefined,
				null, // No context
			);

			expect(result.content[0]).toEqual({
				type: "text",
				text: "Error: User prompt requires interactive mode",
			});
			expect(result.details.cancelled).toBe(true);
		});

		it("returns error when context has no UI", async () => {
			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Test?",
					options: [{ label: "A" }],
					multi: false,
					allow_other: true,
				},
				undefined,
				undefined,
				{ hasUI: false }, // Context without UI
			);

			expect(result.content[0]).toEqual({
				type: "text",
				text: "Error: User prompt requires interactive mode",
			});
			expect(result.details.cancelled).toBe(true);
		});
	});

	describe("execute - single selection", () => {
		it("handles single selection with recommendation", async () => {
			const mockSelect = vi.fn().mockResolvedValue("Option B (Recommended)");

			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Pick one?",
					options: [{ label: "Option A" }, { label: "Option B" }],
					multi: false,
					allow_other: true,
					recommended: 1,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: mockSelect,
						input: vi.fn(),
						custom: vi.fn(),
					},
				},
			);

			expect(mockSelect).toHaveBeenCalledWith("Pick one?", [
				"Option A",
				"Option B (Recommended)",
				"Other (type your own)",
			]);
			expect(result.details.selected).toEqual(["Option B"]);
			expect(result.details.multi).toBe(false);
			expect(result.details.cancelled).toBe(false);
		});

		it("handles custom input selection", async () => {
			const mockSelect = vi.fn().mockResolvedValue("Other (type your own)");
			const mockInput = vi.fn().mockResolvedValue("My custom answer");

			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Pick one?",
					options: [{ label: "Option A" }],
					multi: false,
					allow_other: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: mockSelect,
						input: mockInput,
						custom: vi.fn(),
					},
				},
			);

			expect(mockInput).toHaveBeenCalledWith("Enter your response:");
			expect(result.details.custom_input).toBe("My custom answer");
			expect(result.details.selected).toEqual([]);
		});

		it("handles cancellation (undefined selection)", async () => {
			const mockSelect = vi.fn().mockResolvedValue(undefined);

			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Pick one?",
					options: [{ label: "Option A" }],
					multi: false,
					allow_other: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: mockSelect,
						input: vi.fn(),
						custom: vi.fn(),
					},
				},
			);

			expect(result.details.cancelled).toBe(true);
			expect(result.content[0].text).toBe("User cancelled the selection");
		});

		it("disallows other when allow_other is false", async () => {
			const mockSelect = vi.fn().mockResolvedValue("Option A");

			await registeredTool.execute(
				"test-id",
				{
					question: "Pick one?",
					options: [{ label: "Option A" }],
					multi: false,
					allow_other: false,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: mockSelect,
						input: vi.fn(),
						custom: vi.fn(),
					},
				},
			);

			expect(mockSelect).toHaveBeenCalledWith(
				"Pick one?",
				["Option A"], // No "Other" option
			);
		});
	});

	describe("execute - multi selection", () => {
		it("uses custom UI for multi selection", async () => {
			const mockCustom = vi.fn().mockResolvedValue({
				selected: ["Option A", "Option B"],
				cancelled: false,
			});

			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Pick multiple?",
					options: [{ label: "Option A" }, { label: "Option B" }],
					multi: true,
					allow_other: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: vi.fn(),
						input: vi.fn(),
						custom: mockCustom,
					},
				},
			);

			expect(mockCustom).toHaveBeenCalled();
			expect(result.details.multi).toBe(true);
			expect(result.details.selected).toEqual(["Option A", "Option B"]);
			expect(result.content[0].text).toBe("User selected: Option A, Option B");
		});

		it("handles multi selection with custom input", async () => {
			const mockCustom = vi.fn().mockResolvedValue({
				selected: ["Option A"],
				custom_input: "My custom",
				cancelled: false,
			});

			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Pick?",
					options: [{ label: "Option A" }],
					multi: true,
					allow_other: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: vi.fn(),
						input: vi.fn(),
						custom: mockCustom,
					},
				},
			);

			expect(result.details.custom_input).toBe("My custom");
			expect(result.content[0].text).toContain("Option A");
			expect(result.content[0].text).toContain("My custom");
		});

		it("handles multi selection cancellation", async () => {
			const mockCustom = vi.fn().mockResolvedValue({
				selected: [],
				cancelled: true,
			});

			const result = await registeredTool.execute(
				"test-id",
				{
					question: "Pick?",
					options: [{ label: "Option A" }],
					multi: true,
					allow_other: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						select: vi.fn(),
						input: vi.fn(),
						custom: mockCustom,
					},
				},
			);

			expect(result.details.cancelled).toBe(true);
		});
	});

	describe("renderCall", () => {
		const createTheme = () => ({
			bold: (s: string) => `**${s}**`,
			fg: (_color: string, s: string) => s,
		});

		it("renders basic call with question", () => {
			const theme = createTheme();
			const args = {
				question: "What should I do?",
				options: [{ label: "A" }, { label: "B" }],
			};

			const result = registeredTool.renderCall(args, theme);
			expect(result.text).toContain("ask_user");
			expect(result.text).toContain("What should I do?");
			expect(result.text).toContain("2 options");
		});

		it("shows multi flag in call", () => {
			const theme = createTheme();
			const args = {
				question: "Pick?",
				options: [{ label: "A" }],
				multi: true,
			};

			const result = registeredTool.renderCall(args, theme);
			expect(result.text).toContain("multi");
		});

		it("shows other flag when allow_other is true (default)", () => {
			const theme = createTheme();
			const args = {
				question: "Pick?",
				options: [{ label: "A" }],
				allow_other: true,
			};

			const result = registeredTool.renderCall(args, theme);
			expect(result.text).toContain("other");
		});

		it("hides other flag when allow_other is false", () => {
			const theme = createTheme();
			const args = {
				question: "Pick?",
				options: [{ label: "A" }],
				allow_other: false,
			};

			const result = registeredTool.renderCall(args, theme);
			expect(result.text).not.toContain("other");
		});
	});

	describe("renderResult", () => {
		const createTheme = () => ({
			bold: (s: string) => `**${s}**`,
			fg: (color: string, s: string) => `[${color}:${s}]`,
		});

		it("renders cancelled result", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "User cancelled" }],
				details: {
					cancelled: true,
					selected: [],
					multi: false,
					question: "Test?",
					options: ["A"],
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("Cancelled");
		});

		it("renders single selection result", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "User selected: Option A" }],
				details: {
					cancelled: false,
					selected: ["Option A"],
					multi: false,
					question: "Test?",
					options: ["Option A"],
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("Option A");
		});

		it("renders multi selection result with tree view", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "User selected: A, B" }],
				details: {
					cancelled: false,
					selected: ["A", "B"],
					multi: true,
					question: "Test?",
					options: ["A", "B"],
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("2 selected");
			expect(rendered.text).toContain("A");
			expect(rendered.text).toContain("B");
		});

		it("renders custom input result", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "User provided custom input: My answer" }],
				details: {
					cancelled: false,
					selected: [],
					custom_input: "My answer",
					multi: false,
					question: "Test?",
					options: ["A"],
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("My answer");
		});

		it("renders combined selection and custom input", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "User selected: A; and provided custom input: B" }],
				details: {
					cancelled: false,
					selected: ["A"],
					custom_input: "B",
					multi: true,
					question: "Test?",
					options: ["A"],
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("A");
			expect(rendered.text).toContain("B");
		});

		it("renders no selection result", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					cancelled: false,
					selected: [],
					multi: false,
					question: "Test?",
					options: ["A"],
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("No selection");
		});

		it("falls back to content text when no details", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Plain text result" }],
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toBe("Plain text result");
		});
	});
});
