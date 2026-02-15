/**
 * Exa Tools Extension for pi
 *
 * Provides exa_search and exa_contents tools via direct HTTP API.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const EXA_API_BASE = "https://api.exa.ai";

/** Theme for rendering */
interface Theme {
	bold: (s: string) => string;
	dim: (s: string) => string;
	error: (s: string) => string;
}

/** Tool execution context */
interface ToolContext {
	hasUI: boolean;
	ui: {
		notify: (message: string, type: "warning" | "error" | "info") => void;
	};
}

/** Search tool parameters */
interface SearchParams {
	query: string;
	type?: "auto" | "neural" | "fast" | "deep" | "instant";
	num_results?: number;
	include_domains?: string[];
	exclude_domains?: string[];
	start_published_date?: string;
	end_published_date?: string;
	include_text?: boolean;
	highlights?: boolean;
	summary?: boolean;
}

/** Contents tool parameters */
interface ContentsParams {
	urls: string[];
	text?: boolean;
	highlights?: boolean;
	summary?: boolean;
	max_characters?: number;
}

/** Progress update callback */
type OnUpdate = (update: { type: string; message: string }) => void;

/** Constants */
const CONTENT_PREVIEW_LENGTH = 500;
const MAX_NUM_RESULTS = 100;
const DEFAULT_NUM_RESULTS = 10;
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

/** Get Exa API key from environment */
function getExaApiKey(): string | null {
	// @ts-ignore - process.env is available in Node.js runtime
	return process.env.EXA_API_KEY ?? null;
}

/** Validate ISO 8601 date string */
function isValidISODate(dateStr: string): boolean {
	const isoRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/;
	return isoRegex.test(dateStr);
}

/** Validate URL format */
function isValidUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

/** Search result with content */
interface ExaResult {
	id: string;
	url: string;
	title?: string;
	publishedDate?: string | null;
	author?: string | null;
	text?: string;
	highlights?: string[];
	summary?: string;
}

/** Search response */
interface ExaSearchResponse {
	requestId: string;
	results: ExaResult[];
	searchType?: "neural" | "deep";
	costDollars?: { total: number };
}

/** Contents response */
interface ExaContentsResponse {
	requestId: string;
	results: ExaResult[];
	statuses: Array<{ id: string; status: "success" | "error"; error?: unknown }>;
	costDollars?: { total: number };
}

/** Make request to Exa API with abort support and timeout */
async function exaRequest<T>(
	endpoint: "/search" | "/contents",
	body: Record<string, unknown>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<T> {
	// Create a combined controller for both timeout and external abort
	const controller = new AbortController();

	// Set up timeout
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, REQUEST_TIMEOUT_MS);

	// Forward external abort to our controller
	if (signal) {
		if (signal.aborted) {
			clearTimeout(timeoutId);
			throw new Error("Request aborted by user");
		}
		signal.addEventListener("abort", () => {
			controller.abort();
		}, { once: true });
	}

	try {
		const response = await fetch(`${EXA_API_BASE}${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();

			// Handle rate limiting
			if (response.status === 429) {
				throw new Error(`Exa API rate limit exceeded. Please try again later. (429)`);
			}

			throw new Error(`Exa API error (${response.status}): ${errorText}`);
		}

		return response.json() as Promise<T>;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Format results for display */
function formatResults(results: ExaResult[], forSearch = true): string {
	if (results.length === 0) return "No results found.";

	let output = "";
	for (const r of results) {
		output += `\n## ${r.title ?? "Untitled"}\n`;
		output += `**URL:** ${r.url}\n`;
		if (r.author) output += `**Author:** ${r.author}\n`;
		if (r.publishedDate) output += `**Published:** ${r.publishedDate}\n`;

		// Only show text preview for search results, not contents
		if (forSearch && r.text) {
			output += `\n**Content:**\n${r.text.slice(0, CONTENT_PREVIEW_LENGTH)}${r.text.length > CONTENT_PREVIEW_LENGTH ? "..." : ""}\n`;
		} else if (!forSearch && r.text) {
			// For contents, show full text
			output += `\n**Content:**\n${r.text}\n`;
		}

		if (r.highlights?.length) {
			output += `\n**Highlights:**\n`;
			for (const h of r.highlights) {
				output += `- ${h}\n`;
			}
		}

		if (r.summary) {
			output += `\n**Summary:** ${r.summary}\n`;
		}

		output += "\n";
	}

	return output.trim();
}

/** Main extension entry point */
export default function (pi: ExtensionAPI) {
	// Register exa_search tool
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description: `Search the web using Exa's neural, keyword, or deep search.

Returns relevant web pages with optional content extraction.

Parameters:
- query: Search query (required)
- type: Search type - auto (default), neural, fast, deep, or instant
- num_results: Max results (default: 10, max: 100)
- include_domains/exclude_domains: Domain filters
- start/end_published_date: Date filters (ISO 8601)
- include_text: Return full page content
- highlights: Return relevant text snippets
- summary: Return LLM-generated summaries`,

		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			type: Type.Optional(
				Type.Union(
					[
						Type.Literal("auto"),
						Type.Literal("neural"),
						Type.Literal("fast"),
						Type.Literal("deep"),
						Type.Literal("instant"),
					],
					{ description: "Search type" },
				),
			),
			num_results: Type.Optional(
				Type.Number({ description: "Number of results (max 100)", minimum: 1, maximum: MAX_NUM_RESULTS }),
			),
			include_domains: Type.Optional(Type.Array(Type.String(), { description: "Only include these domains" })),
			exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains" })),
			start_published_date: Type.Optional(Type.String({ description: "Published after (ISO 8601)" })),
			end_published_date: Type.Optional(Type.String({ description: "Published before (ISO 8601)" })),
			include_text: Type.Optional(Type.Boolean({ description: "Include full page text" })),
			highlights: Type.Optional(Type.Boolean({ description: "Include relevant snippets" })),
			summary: Type.Optional(Type.Boolean({ description: "Include LLM summary" })),
		}),

		async execute(_toolCallId: string, params: SearchParams, signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
			const apiKey = getExaApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found in environment" }],
					details: { error: "EXA_API_KEY not found" },
				};
			}

			// Validate date formats
			if (params.start_published_date && !isValidISODate(params.start_published_date)) {
				return {
					content: [{ type: "text" as const, text: "Error: start_published_date must be a valid ISO 8601 date string" }],
					details: { error: "Invalid date format" },
				};
			}
			if (params.end_published_date && !isValidISODate(params.end_published_date)) {
				return {
					content: [{ type: "text" as const, text: "Error: end_published_date must be a valid ISO 8601 date string" }],
					details: { error: "Invalid date format" },
				};
			}

			// Validate num_results
			const numResults = params.num_results ?? DEFAULT_NUM_RESULTS;
			if (numResults < 1 || numResults > MAX_NUM_RESULTS) {
				return {
					content: [{ type: "text" as const, text: `Error: num_results must be between 1 and ${MAX_NUM_RESULTS}` }],
					details: { error: "Invalid num_results" },
				};
			}

			try {
				const body: Record<string, unknown> = {
					query: params.query,
					type: params.type ?? "auto",
					numResults,
				};

				if (params.include_domains?.length) body.includeDomains = params.include_domains;
				if (params.exclude_domains?.length) body.excludeDomains = params.exclude_domains;
				if (params.start_published_date) body.startPublishedDate = params.start_published_date;
				if (params.end_published_date) body.endPublishedDate = params.end_published_date;
				if (params.include_text === true) body.text = true;
				if (params.highlights === true) body.highlights = true;
				if (params.summary === true) body.summary = true;

				const response = await exaRequest<ExaSearchResponse>("/search", body, apiKey, signal);

				const formatted = formatResults(response.results, true);
				const output = [
					`## Search Results (${response.results.length})`,
					`Type: ${response.searchType ?? params.type ?? "auto"}`,
					response.costDollars ? `Cost: $${response.costDollars.total.toFixed(4)}` : "",
					"",
					formatted,
				]
					.filter(Boolean)
					.join("\n");

				return {
					content: [{ type: "text" as const, text: output }],
					details: { response },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { error: message },
				};
			}
		},

		renderCall(args: SearchParams, theme: Theme) {
			const typeLabel = args.type ?? "auto";
			const text = `${theme.bold("exa_search")} ${theme.dim(typeLabel)}: "${args.query.slice(0, 50)}${args.query.length > 50 ? "..." : ""}"`;
			return new Text(text, 0, 0);
		},

		renderResult(result: { details?: { error?: string; response?: unknown } }, _options: unknown, theme: Theme) {
			if (result.details?.error) {
				return new Text(theme.error(`Error: ${result.details.error}`), 0, 0);
			}

			// Type guard for ExaSearchResponse
			const isExaSearchResponse = (data: unknown): data is ExaSearchResponse => {
				if (typeof data !== "object" || data === null) return false;
				const resp = data as Record<string, unknown>;
				return Array.isArray(resp.results) && typeof resp.requestId === "string";
			};

			const response = isExaSearchResponse(result.details?.response) ? result.details.response : undefined;
			if (!response) return new Text("No results", 0, 0);

			const lines: string[] = [];
			lines.push(`${response.results.length} results`);
			if (response.costDollars) {
				lines.push(`Cost: $${response.costDollars.total.toFixed(4)}`);
			}
			return new Text(lines.join(" | "), 0, 0);
		},
	});

	// Register exa_contents tool
	pi.registerTool({
		name: "exa_contents",
		label: "Exa Contents",
		description: `Extract content from specific URLs using Exa.

Fetches full page content, highlights, and summaries from URLs you already know.
Returns instant results from cache with automatic live crawling fallback.

Parameters:
- urls: Array of URLs to extract content from (required)
- text: Include full page text (default: true)
- highlights: Include relevant text snippets (default: false)
- summary: Include LLM-generated summary (default: false)
- max_characters: Limit text/highlights length per page`,

		parameters: Type.Object({
			urls: Type.Array(Type.String(), {
				description: "URLs to extract content from",
				minItems: 1,
			}),
			text: Type.Optional(Type.Boolean({ description: "Include full page text" })),
			highlights: Type.Optional(Type.Boolean({ description: "Include highlights" })),
			summary: Type.Optional(Type.Boolean({ description: "Include summary" })),
			max_characters: Type.Optional(Type.Number({ description: "Max characters per page", minimum: 1 })),
		}),

		async execute(_toolCallId: string, params: ContentsParams, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, _ctx: unknown) {
			const apiKey = getExaApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found in environment" }],
					details: { error: "EXA_API_KEY not found" },
				};
			}

			// Validate URLs
			const invalidUrls = params.urls.filter((u: string) => !isValidUrl(u));
			if (invalidUrls.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: Invalid URL format detected: ${invalidUrls.join(", ")}`,
						},
					],
					details: { error: "Invalid URL format", invalidUrls },
				};
			}

			// Validate max_characters
			if (params.max_characters !== undefined && params.max_characters < 1) {
				return {
					content: [{ type: "text" as const, text: "Error: max_characters must be at least 1" }],
					details: { error: "Invalid max_characters" },
				};
			}

			try {
				const body: Record<string, unknown> = {
					urls: params.urls,
				};

				// Configure text extraction - default to true if not specified
				const includeText = params.text !== false;
				if (includeText) {
					if (params.max_characters) {
						body.text = { maxCharacters: params.max_characters };
					} else {
						body.text = true;
					}
				}

				if (params.highlights === true) {
					if (params.max_characters) {
						body.highlights = { maxCharacters: params.max_characters };
					} else {
						body.highlights = true;
					}
				}

				if (params.summary === true) {
					body.summary = true;
				}

				// Report start progress
				onUpdate?.({ type: "progress", message: `Fetching content from ${params.urls.length} URL${params.urls.length === 1 ? "" : "s"}...` });

				const response = await exaRequest<ExaContentsResponse>("/contents", body, apiKey, signal);

				// Build output with status info
				let output = `## Contents Extracted (${response.results.length}/${params.urls.length})\n`;
				if (response.costDollars) {
					output += `Cost: $${response.costDollars.total.toFixed(4)}\n`;
				}
				output += "\n";

				// Show any errors
				const errors = response.statuses.filter((s) => s.status === "error");
				if (errors.length > 0) {
					output += `**Errors (${errors.length}):**\n`;
					for (const err of errors) {
						output += `- ${err.id}: ${err.error ? String(err.error) : "Unknown error"}\n`;
					}
					output += "\n";
				}

				// Show results - for contents, show full text without preview truncation
				output += formatResults(response.results, false);

				return {
					content: [{ type: "text" as const, text: output }],
					details: { response },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { error: message },
				};
			}
		},

		renderCall(args: ContentsParams, theme: Theme) {
			const features: string[] = [];
			if (args.text !== false) features.push("text");
			if (args.highlights) features.push("highlights");
			if (args.summary) features.push("summary");

			const text = `${theme.bold("exa_contents")} ${theme.dim(String(args.urls.length))} URL${args.urls.length === 1 ? "" : "s"} (${features.join("|")})`;
			return new Text(text, 0, 0);
		},

		renderResult(result: { details?: { error?: string; response?: unknown } }, _options: unknown, theme: Theme) {
			if (result.details?.error) {
				return new Text(theme.error(`Error: ${result.details.error}`), 0, 0);
			}

			// Type guard for ExaContentsResponse
			const isExaContentsResponse = (data: unknown): data is ExaContentsResponse => {
				if (typeof data !== "object" || data === null) return false;
				const resp = data as Record<string, unknown>;
				return (
					Array.isArray(resp.results) &&
					Array.isArray(resp.statuses) &&
					typeof resp.requestId === "string"
				);
			};

			const response = isExaContentsResponse(result.details?.response) ? result.details.response : undefined;
			if (!response) return new Text("No results", 0, 0);

			const successCount = response.statuses.filter((s: { status: string }) => s.status === "success").length;
			const errorCount = response.statuses.length - successCount;

			const lines: string[] = [];
			lines.push(`${successCount}/${response.statuses.length} URLs fetched`);
			if (errorCount > 0) {
				lines.push(`${errorCount} errors`);
			}
			if (response.costDollars) {
				lines.push(`$${response.costDollars.total.toFixed(4)}`);
			}
			return new Text(lines.join(" | "), 0, 0);
		},
	});

	// Warn if API key is missing
	pi.on("session_start", async (_event: unknown, ctx: ToolContext) => {
		if (!getExaApiKey()) {
			ctx.ui.notify("EXA_API_KEY not set - exa_search and exa_contents will fail", "warning");
		}
	});
}
