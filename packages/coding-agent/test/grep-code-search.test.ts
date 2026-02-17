import { beforeEach, describe, expect, it, vi } from "vitest";
import grepCodeSearchExtension from "../built-in-extensions/grep-code-search.js";

// Mock dependencies
vi.mock("@mariozechner/pi-tui", () => ({
	Text: vi.fn().mockImplementation((text: string, _x: number, _y: number) => ({
		text,
	})),
	truncateToWidth: vi.fn((s: string) => s),
}));

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: {
		error?: string;
		response?: unknown;
	};
}

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	shortDescription?: string;
	systemGuidelines?: string[];
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<ToolResult>;
	renderCall: (args: Record<string, unknown>, theme: Record<string, unknown>) => { text: string };
	renderResult: (result: ToolResult, options: unknown, theme: Record<string, unknown>) => { text: string };
}

describe("grep-code-search extension", () => {
	let registeredTool: RegisteredTool;
	let mockRegisterTool: any;

	beforeEach(() => {
		vi.clearAllMocks();

		mockRegisterTool = vi.fn((tool: RegisteredTool) => {
			registeredTool = tool;
		});

		const mockPi = {
			registerTool: mockRegisterTool,
		};

		grepCodeSearchExtension(mockPi as unknown as Parameters<typeof grepCodeSearchExtension>[0]);
	});

	describe("tool registration", () => {
		it("registers with correct name and label", () => {
			expect(registeredTool.name).toBe("grep_code_search");
			expect(registeredTool.label).toBe("Grep Code Search");
		});

		it("has a description", () => {
			expect(registeredTool.description).toContain("grep.app");
			expect(registeredTool.description).toContain("GitHub");
		});

		it("has shortDescription for system prompt", () => {
			expect(registeredTool.shortDescription).toBe("Search code across GitHub repos via grep.app");
		});

		it("has systemGuidelines", () => {
			expect(registeredTool.systemGuidelines).toBeDefined();
			expect(registeredTool.systemGuidelines!.length).toBeGreaterThan(0);
		});

		it("has parameters with query and from", () => {
			expect(registeredTool.parameters).toBeDefined();
			const props = (registeredTool.parameters as { properties: Record<string, unknown> }).properties;
			expect(props).toHaveProperty("query");
			expect(props).toHaveProperty("from");
		});
	});

	describe("execute - API integration", () => {
		it("makes correct API request with basic query", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						time: 42,
						facets: {},
						hits: { total: 0, hits: [] },
					}),
			});
			global.fetch = mockFetch;

			await registeredTool.execute("test-id", { query: "useEffect cleanup" });

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("https://grep.app/api/search?"),
				expect.objectContaining({
					method: "GET",
					headers: { Accept: "application/json" },
				}),
			);

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("q=useEffect+cleanup");
			expect(url).toContain("from=0");
		});

		it("passes from parameter for pagination", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						time: 10,
						facets: {},
						hits: { total: 0, hits: [] },
					}),
			});
			global.fetch = mockFetch;

			await registeredTool.execute("test-id", { query: "test", from: 20 });

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("from=20");
		});

		it("handles successful response with results", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						time: 35,
						facets: {
							lang: {
								buckets: [{ val: "TypeScript", count: 500 }],
							},
						},
						hits: {
							total: 1234,
							hits: [
								{
									owner_id: "owner1",
									repo: "facebook/react",
									branch: "main",
									path: "src/hooks/useEffect.ts",
									content: { snippet: "<mark>useEffect</mark>(() =&gt; { cleanup(); })" },
									total_matches: "5",
								},
							],
						},
					}),
			});

			const result = await registeredTool.execute("test-id", { query: "useEffect cleanup" });

			expect(result.content[0].text).toContain("Grep.app Search");
			expect(result.content[0].text).toContain("useEffect cleanup");
			expect(result.content[0].text).toContain("facebook/react");
			expect(result.content[0].text).toContain("src/hooks/useEffect.ts");
			expect(result.content[0].text).toContain("github.com");
			expect(result.content[0].text).toContain("TypeScript");
		});

		it("strips HTML tags from snippets", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						time: 10,
						facets: {},
						hits: {
							total: 1,
							hits: [
								{
									owner_id: "o1",
									repo: "user/repo",
									branch: "main",
									path: "file.ts",
									content: {
										snippet: "const x = <mark>foo</mark> &amp; &lt;bar&gt;",
									},
									total_matches: "1",
								},
							],
						},
					}),
			});

			const result = await registeredTool.execute("test-id", { query: "foo" });

			expect(result.content[0].text).toContain("const x = foo & <bar>");
			expect(result.content[0].text).not.toContain("<mark>");
			expect(result.content[0].text).not.toContain("&amp;");
		});

		it("handles empty results", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						time: 5,
						facets: {},
						hits: { total: 0, hits: [] },
					}),
			});

			const result = await registeredTool.execute("test-id", { query: "nonexistent_xyz_123" });

			expect(result.content[0].text).toContain("No results found");
		});

		it("handles API errors", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Internal Server Error"),
			});

			const result = await registeredTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toContain("Error:");
			expect(result.content[0].text).toContain("500");
			expect(result.details?.error).toContain("500");
		});

		it("handles network errors", async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

			const result = await registeredTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toBe("Error: Network failure");
			expect(result.details?.error).toBe("Network failure");
		});

		it("respects abort signal", async () => {
			global.fetch = vi.fn().mockImplementation(() => {
				return new Promise((_, reject) => {
					setTimeout(() => reject(new Error("AbortError")), 10);
				});
			});

			const controller = new AbortController();
			controller.abort();

			const result = await registeredTool.execute("test-id", { query: "test" }, controller.signal);

			expect(result.content[0].text).toContain("Error:");
		});

		it("shows pagination info in results", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						time: 20,
						facets: {},
						hits: {
							total: 500,
							hits: [
								{
									owner_id: "o1",
									repo: "user/repo",
									branch: "main",
									path: "file.ts",
									content: { snippet: "code" },
									total_matches: "1",
								},
							],
						},
					}),
			});

			const result = await registeredTool.execute("test-id", { query: "test", from: 10 });

			expect(result.content[0].text).toContain("Results 11-11 of 500");
		});
	});

	describe("renderCall", () => {
		const createTheme = () => ({
			bold: (s: string) => `**${s}**`,
			fg: (_color: string, s: string) => s,
		});

		it("renders basic search call", () => {
			const theme = createTheme();
			const result = registeredTool.renderCall({ query: "useEffect cleanup" }, theme);

			expect(result.text).toContain("grep_code_search");
			expect(result.text).toContain("useEffect cleanup");
		});

		it("truncates long queries", () => {
			const theme = createTheme();
			const longQuery = "a".repeat(60);
			const result = registeredTool.renderCall({ query: longQuery }, theme);

			expect(result.text).toContain("...");
		});
	});

	describe("renderResult", () => {
		const createTheme = () => ({
			fg: (_color: string, s: string) => s,
		});

		it("renders error result", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Error occurred" }],
				details: { error: "API failure" },
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("API failure");
		});

		it("renders successful results with count and time", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Results" }],
				details: {
					response: {
						time: 42,
						facets: {
							lang: { buckets: [{ val: "Go", count: 1000 }] },
						},
						hits: { total: 5000, hits: [{ owner_id: "1" }] },
					},
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("5,000 matches");
			expect(rendered.text).toContain("42ms");
			expect(rendered.text).toContain("Go");
		});

		it("renders results without language facets", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Results" }],
				details: {
					response: {
						time: 10,
						facets: {},
						hits: { total: 100, hits: [{ owner_id: "1" }] },
					},
				},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("100 matches");
			expect(rendered.text).toContain("10ms");
		});

		it("returns 'No results' for missing response", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {},
			};

			const rendered = registeredTool.renderResult(result, {}, theme);
			expect(rendered.text).toBe("No results");
		});
	});
});
