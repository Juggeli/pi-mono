import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exaToolsExtension from "../built-in-extensions/exa-tools.js";

// Mock dependencies
vi.mock("@mariozechner/pi-tui", () => ({
	Text: vi.fn().mockImplementation((text: string, _x: number, _y: number) => ({
		text,
	})),
	truncateToWidth: vi.fn((s: string) => s),
}));

// Store original env
const originalEnv = process.env;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: {
		error?: string;
		response?: unknown;
		invalidUrls?: string[];
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
		onUpdate?: (update: { type: string; message: string }) => void,
		ctx?: unknown,
	) => Promise<ToolResult>;
	renderCall: (args: Record<string, unknown>, theme: Record<string, unknown>) => { text: string };
	renderResult: (result: ToolResult, options: unknown, theme: Record<string, unknown>) => { text: string };
}

describe("exa-tools extension", () => {
	let registeredTools: Map<string, RegisteredTool>;
	let mockRegisterTool: any;
	let mockNotify: ReturnType<typeof vi.fn>;
	let mockOn: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		delete process.env.EXA_API_KEY;

		registeredTools = new Map();
		mockRegisterTool = vi.fn((tool: RegisteredTool) => {
			registeredTools.set(tool.name, tool);
		});

		mockNotify = vi.fn();
		mockOn = vi.fn();

		const mockPi = {
			registerTool: mockRegisterTool,
			ui: { notify: mockNotify },
			on: mockOn,
		};

		exaToolsExtension(mockPi as unknown as Parameters<typeof exaToolsExtension>[0]);
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("tool registration", () => {
		it("registers exa_search tool", () => {
			const searchTool = registeredTools.get("exa_search");
			expect(searchTool).toBeDefined();
			expect(searchTool?.name).toBe("exa_search");
			expect(searchTool?.label).toBe("Exa Search");
		});

		it("registers exa_contents tool", () => {
			const contentsTool = registeredTools.get("exa_contents");
			expect(contentsTool).toBeDefined();
			expect(contentsTool?.name).toBe("exa_contents");
			expect(contentsTool?.label).toBe("Exa Contents");
		});

		it("registers session_start handler", () => {
			expect(mockOn).toHaveBeenCalledWith("session_start", expect.any(Function));
		});

		it("has shortDescription for system prompt", () => {
			const searchTool = registeredTools.get("exa_search");
			const contentsTool = registeredTools.get("exa_contents");
			expect(searchTool?.shortDescription).toBe("Search the web using Exa neural/keyword/deep search");
			expect(contentsTool?.shortDescription).toBe("Extract content from URLs using Exa");
		});

		it("has systemGuidelines on exa_search", () => {
			const searchTool = registeredTools.get("exa_search")!;
			expect(searchTool.systemGuidelines).toBeDefined();
			expect(searchTool.systemGuidelines!.length).toBeGreaterThan(0);
			expect(searchTool.systemGuidelines).toContain(
				"Use exa_search for web research when you need current information, documentation, or real-world data",
			);
		});

		it("notifies when API key is missing on session start", () => {
			const [, handler] = mockOn.mock.calls.find((call: unknown[]) => call[0] === "session_start") ?? [];
			const mockCtx = { ui: { notify: vi.fn() } };

			if (handler) {
				handler(null, mockCtx);
			}

			expect(mockCtx.ui.notify).toHaveBeenCalledWith(
				"EXA_API_KEY not set - exa_search and exa_contents will fail",
				"warning",
			);
		});

		it("does not notify when API key is present", () => {
			process.env.EXA_API_KEY = "test-key";
			const [, handler] = mockOn.mock.calls.find((call: unknown[]) => call[0] === "session_start") ?? [];
			const mockCtx = { ui: { notify: vi.fn() } };

			if (handler) {
				handler(null, mockCtx);
			}

			expect(mockCtx.ui.notify).not.toHaveBeenCalled();
		});
	});

	describe("exa_search - validation", () => {
		let searchTool: RegisteredTool;

		beforeEach(() => {
			searchTool = registeredTools.get("exa_search")!;
		});

		it("returns error when EXA_API_KEY is not set", async () => {
			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0]).toEqual({
				type: "text",
				text: "Error: EXA_API_KEY not found in environment",
			});
			expect(result.details?.error).toBe("EXA_API_KEY not found");
		});

		it("returns error for invalid start_published_date format", async () => {
			process.env.EXA_API_KEY = "test-key";
			const result = await searchTool.execute("test-id", {
				query: "test",
				start_published_date: "not-a-date",
			});

			expect(result.content[0]).toEqual({
				type: "text",
				text: "Error: start_published_date must be a valid ISO 8601 date string",
			});
		});

		it("returns error for invalid end_published_date format", async () => {
			process.env.EXA_API_KEY = "test-key";
			const result = await searchTool.execute("test-id", {
				query: "test",
				end_published_date: "2023/01/01",
			});

			expect(result.content[0]).toEqual({
				type: "text",
				text: "Error: end_published_date must be a valid ISO 8601 date string",
			});
		});

		it("accepts valid ISO date formats", async () => {
			process.env.EXA_API_KEY = "test-key";
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "test-123",
						results: [],
					}),
			});

			const validDates = [
				"2023-01-15",
				"2023-01-15T10:30:00",
				"2023-01-15T10:30:00Z",
				"2023-01-15T10:30:00+00:00",
				"2023-01-15T10:30:00.123Z",
			];

			for (const date of validDates) {
				const result = await searchTool.execute("test-id", {
					query: "test",
					start_published_date: date,
					end_published_date: date,
				});

				expect(result.details?.error).toBeUndefined();
			}
		});
	});

	describe("exa_contents - validation", () => {
		let contentsTool: RegisteredTool;

		beforeEach(() => {
			contentsTool = registeredTools.get("exa_contents")!;
		});

		it("returns error when EXA_API_KEY is not set", async () => {
			const result = await contentsTool.execute("test-id", {
				urls: ["https://example.com"],
			});

			expect(result.content[0]).toEqual({
				type: "text",
				text: "Error: EXA_API_KEY not found in environment",
			});
		});

		it("returns error for invalid URLs", async () => {
			process.env.EXA_API_KEY = "test-key";
			const result = await contentsTool.execute("test-id", {
				urls: ["not-a-url", "also-not-valid"],
			});

			expect(result.content[0].text).toContain("Invalid URL format detected");
			expect(result.details?.invalidUrls).toEqual(["not-a-url", "also-not-valid"]);
		});

		it("accepts valid URLs", async () => {
			process.env.EXA_API_KEY = "test-key";
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "test-123",
						results: [],
						statuses: [{ id: "https://example.com", status: "success" }],
					}),
			});

			const result = await contentsTool.execute("test-id", {
				urls: ["https://example.com", "http://test.org/page"],
			});

			expect(result.details?.error).toBeUndefined();
		});
	});

	describe("exa_search - API integration", () => {
		let searchTool: RegisteredTool;

		beforeEach(() => {
			searchTool = registeredTools.get("exa_search")!;
			process.env.EXA_API_KEY = "test-api-key";
		});

		it("makes correct API request with basic params", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-123",
						results: [],
						searchType: "neural",
					}),
			});
			global.fetch = mockFetch;

			await searchTool.execute("test-id", { query: "artificial intelligence" });

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.exa.ai/search",
				expect.objectContaining({
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": "test-api-key",
					},
				}),
			);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody).toEqual({
				query: "artificial intelligence",
				type: "auto",
				numResults: 10,
			});
		});

		it("includes optional parameters in API request", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-123",
						results: [],
					}),
			});
			global.fetch = mockFetch;

			await searchTool.execute("test-id", {
				query: "machine learning",
				type: "deep",
				num_results: 5,
				include_domains: ["arxiv.org", "github.com"],
				exclude_domains: ["pinterest.com"],
				start_published_date: "2023-01-01",
				end_published_date: "2024-12-31",
				include_text: true,
				highlights: true,
				summary: true,
			});

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody).toEqual({
				query: "machine learning",
				type: "deep",
				numResults: 5,
				includeDomains: ["arxiv.org", "github.com"],
				excludeDomains: ["pinterest.com"],
				startPublishedDate: "2023-01-01",
				endPublishedDate: "2024-12-31",
				text: true,
				highlights: true,
				summary: true,
			});
		});

		it("handles successful response with results", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-456",
						results: [
							{
								id: "result-1",
								url: "https://example.com/article",
								title: "Test Article",
								author: "John Doe",
								publishedDate: "2024-01-15",
								text: "This is the content of the article...",
								highlights: ["Key point one", "Key point two"],
								summary: "A brief summary",
							},
						],
						searchType: "neural",
						costDollars: { total: 0.05 },
					}),
			});

			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toContain("Search Results (1)");
			expect(result.content[0].text).toContain("Test Article");
			expect(result.content[0].text).toContain("John Doe");
			expect(result.content[0].text).toContain("Cost: $0.0500");
		});

		it("handles rate limit error (429)", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 429,
				text: () => Promise.resolve("Rate limited"),
			});

			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toContain("429");
			expect(result.details?.error).toContain("429");
		});

		it("handles generic API errors", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Internal Server Error"),
			});

			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toContain("Error:");
			expect(result.content[0].text).toContain("500");
		});

		it("handles network errors", async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toBe("Error: Network failure");
			expect(result.details?.error).toBe("Network failure");
		});

		it("respects abort signal", async () => {
			const mockFetch = vi.fn().mockImplementation(() => {
				return new Promise((_, reject) => {
					setTimeout(() => reject(new Error("AbortError")), 10);
				});
			});
			global.fetch = mockFetch;

			const controller = new AbortController();
			controller.abort();

			const result = await searchTool.execute("test-id", { query: "test" }, controller.signal);

			expect(result.content[0].text).toContain("Error:");
		});
	});

	describe("exa_contents - API integration", () => {
		let contentsTool: RegisteredTool;

		beforeEach(() => {
			contentsTool = registeredTools.get("exa_contents")!;
			process.env.EXA_API_KEY = "test-api-key";
		});

		it("makes correct API request with basic params", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-789",
						results: [],
						statuses: [{ id: "https://example.com", status: "success" }],
					}),
			});
			global.fetch = mockFetch;

			await contentsTool.execute("test-id", { urls: ["https://example.com"] });

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.exa.ai/contents",
				expect.objectContaining({
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": "test-api-key",
					},
				}),
			);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody).toEqual({
				urls: ["https://example.com"],
				text: true,
			});
		});

		it("makes API request with all optional params", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-789",
						results: [],
						statuses: [
							{ id: "https://example.com", status: "success" },
							{ id: "https://test.org", status: "success" },
						],
					}),
			});
			global.fetch = mockFetch;

			await contentsTool.execute("test-id", {
				urls: ["https://example.com", "https://test.org"],
				text: true,
				highlights: true,
				summary: true,
				max_characters: 1000,
			});

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody).toEqual({
				urls: ["https://example.com", "https://test.org"],
				text: { maxCharacters: 1000 },
				highlights: { maxCharacters: 1000 },
				summary: true,
			});
		});

		it("disables text extraction when text is false", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-789",
						results: [],
						statuses: [{ id: "https://example.com", status: "success" }],
					}),
			});
			global.fetch = mockFetch;

			await contentsTool.execute("test-id", {
				urls: ["https://example.com"],
				text: false,
			});

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody).not.toHaveProperty("text");
		});

		it("handles successful response with content", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-999",
						results: [
							{
								id: "https://example.com",
								url: "https://example.com",
								title: "Example Page",
								text: "Full page content here...",
							},
						],
						statuses: [{ id: "https://example.com", status: "success" }],
						costDollars: { total: 0.01 },
					}),
			});

			const result = await contentsTool.execute("test-id", {
				urls: ["https://example.com"],
			});

			expect(result.content[0].text).toContain("Contents Extracted (1/1)");
			expect(result.content[0].text).toContain("Example Page");
			expect(result.content[0].text).toContain("Full page content here...");
		});

		it("handles partial failures with errors section", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-999",
						results: [
							{
								id: "https://example.com",
								url: "https://example.com",
								title: "Success Page",
								text: "Content",
							},
						],
						statuses: [
							{ id: "https://example.com", status: "success" },
							{ id: "https://failed.com", status: "error", error: "Timeout" },
						],
					}),
			});

			const result = await contentsTool.execute("test-id", {
				urls: ["https://example.com", "https://failed.com"],
			});

			expect(result.content[0].text).toContain("Contents Extracted (1/2)");
			expect(result.content[0].text).toContain("Errors (1)");
			expect(result.content[0].text).toContain("Timeout");
		});
	});

	describe("exa_search - renderCall", () => {
		let searchTool: RegisteredTool;
		const createTheme = () => ({
			bold: (s: string) => `**${s}**`,
			fg: (_color: string, s: string) => s,
		});

		beforeEach(() => {
			searchTool = registeredTools.get("exa_search")!;
		});

		it("renders basic search call", () => {
			const theme = createTheme();
			const result = searchTool.renderCall({ query: "machine learning" }, theme);

			expect(result.text).toContain("exa_search");
			expect(result.text).toContain("machine learning");
			expect(result.text).toContain("auto");
		});

		it("renders search call with custom type", () => {
			const theme = createTheme();
			const result = searchTool.renderCall({ query: "AI news", type: "deep" }, theme);

			expect(result.text).toContain("deep");
		});

		it("truncates long queries", () => {
			const theme = createTheme();
			const longQuery = "a".repeat(100);
			const result = searchTool.renderCall({ query: longQuery }, theme);

			expect(result.text).toContain("...");
			expect(result.text.length).toBeLessThan(longQuery.length + 50);
		});
	});

	describe("exa_search - renderResult", () => {
		let searchTool: RegisteredTool;
		const createTheme = () => ({
			fg: (_color: string, s: string) => s,
		});

		beforeEach(() => {
			searchTool = registeredTools.get("exa_search")!;
		});

		it("renders error result", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Error occurred" }],
				details: { error: "API failure" },
			};

			const rendered = searchTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("API failure");
		});

		it("renders successful search results with count and cost", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Results" }],
				details: {
					response: {
						requestId: "req-1",
						results: [{ id: "1" }, { id: "2" }, { id: "3" }],
						costDollars: { total: 0.1234 },
					},
				},
			};

			const rendered = searchTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("3 results");
			expect(rendered.text).toContain("$0.1234");
		});

		it("renders results without cost info", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Results" }],
				details: {
					response: {
						requestId: "req-1",
						results: [{ id: "1" }],
					},
				},
			};

			const rendered = searchTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("1 results");
			expect(rendered.text).not.toContain("Cost");
		});

		it("returns 'No results' for missing response", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {},
			};

			const rendered = searchTool.renderResult(result, {}, theme);
			expect(rendered.text).toBe("No results");
		});
	});

	describe("exa_contents - renderCall", () => {
		let contentsTool: RegisteredTool;
		const createTheme = () => ({
			bold: (s: string) => `**${s}**`,
			fg: (_color: string, s: string) => s,
		});

		beforeEach(() => {
			contentsTool = registeredTools.get("exa_contents")!;
		});

		it("renders basic contents call", () => {
			const theme = createTheme();
			const result = contentsTool.renderCall({ urls: ["https://example.com"] }, theme);

			expect(result.text).toContain("exa_contents");
			expect(result.text).toContain("1");
			expect(result.text).toContain("URL");
			expect(result.text).toContain("text");
		});

		it("shows plural for multiple URLs", () => {
			const theme = createTheme();
			const result = contentsTool.renderCall({ urls: ["https://a.com", "https://b.com", "https://c.com"] }, theme);

			expect(result.text).toContain("3");
			expect(result.text).toContain("URLs");
		});

		it("shows enabled features", () => {
			const theme = createTheme();
			const result = contentsTool.renderCall(
				{
					urls: ["https://example.com"],
					text: true,
					highlights: true,
					summary: true,
				},
				theme,
			);

			expect(result.text).toContain("text");
			expect(result.text).toContain("highlights");
			expect(result.text).toContain("summary");
		});
	});

	describe("exa_contents - renderResult", () => {
		let contentsTool: RegisteredTool;
		const createTheme = () => ({
			fg: (_color: string, s: string) => s,
		});

		beforeEach(() => {
			contentsTool = registeredTools.get("exa_contents")!;
		});

		it("renders error result", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Error occurred" }],
				details: { error: "Network error" },
			};

			const rendered = contentsTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("Network error");
		});

		it("renders successful contents extraction with stats", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Results" }],
				details: {
					response: {
						requestId: "req-1",
						results: [{ id: "1" }, { id: "2" }],
						statuses: [
							{ id: "1", status: "success" },
							{ id: "2", status: "success" },
						],
						costDollars: { total: 0.005 },
					},
				},
			};

			const rendered = contentsTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("2/2 URLs fetched");
			expect(rendered.text).toContain("$0.0050");
		});

		it("shows error count for partial failures", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "Results" }],
				details: {
					response: {
						requestId: "req-1",
						results: [{ id: "1" }],
						statuses: [
							{ id: "1", status: "success" },
							{ id: "2", status: "error" },
							{ id: "3", status: "error" },
						],
						costDollars: { total: 0.01 },
					},
				},
			};

			const rendered = contentsTool.renderResult(result, {}, theme);
			expect(rendered.text).toContain("1/3 URLs fetched");
			expect(rendered.text).toContain("2 errors");
		});

		it("returns 'No results' for missing response", () => {
			const theme = createTheme();
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {},
			};

			const rendered = contentsTool.renderResult(result, {}, theme);
			expect(rendered.text).toBe("No results");
		});
	});

	describe("result formatting", () => {
		let searchTool: RegisteredTool;

		beforeEach(() => {
			searchTool = registeredTools.get("exa_search")!;
			process.env.EXA_API_KEY = "test-key";
		});

		it("formats results with all fields", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-1",
						results: [
							{
								id: "r1",
								url: "https://example.com/article",
								title: "The Title",
								author: "Jane Smith",
								publishedDate: "2024-06-01",
								text: "a".repeat(600),
								highlights: ["Highlight 1", "Highlight 2"],
								summary: "The summary",
							},
						],
					}),
			});

			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toContain("The Title");
			expect(result.content[0].text).toContain("Jane Smith");
			expect(result.content[0].text).toContain("2024-06-01");
			expect(result.content[0].text).toContain("...");
			expect(result.content[0].text).toContain("Highlight 1");
			expect(result.content[0].text).toContain("The summary");
		});

		it("handles results without optional fields", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-1",
						results: [
							{
								id: "r1",
								url: "https://example.com",
							},
						],
					}),
			});

			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toContain("Untitled");
			expect(result.content[0].text).toContain("https://example.com");
		});

		it("handles empty results", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-1",
						results: [],
					}),
			});

			const result = await searchTool.execute("test-id", { query: "test" });

			expect(result.content[0].text).toContain("Search Results (0)");
		});

		it("shows full text for contents without truncation", async () => {
			const contentsTool = registeredTools.get("exa_contents")!;
			const longText = "Content ".repeat(100);

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						requestId: "req-1",
						results: [
							{
								id: "r1",
								url: "https://example.com",
								title: "Page",
								text: longText,
							},
						],
						statuses: [{ id: "https://example.com", status: "success" }],
					}),
			});

			const result = await contentsTool.execute("test-id", {
				urls: ["https://example.com"],
			});

			expect(result.content[0].text).toContain("Content Content");
		});
	});
});
