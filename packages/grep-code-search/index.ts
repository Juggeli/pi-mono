/**
 * Grep Code Search Extension for pi
 *
 * Provides code search via grep.app API - searches millions of GitHub repos.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const GREP_API_BASE = "https://grep.app/api";

/** Constants */
const DEFAULT_PER_PAGE = 10;
const MAX_RESULTS = 1000; // API returns max 1000 results
const REQUEST_TIMEOUT_MS = 30000;

/** Grep.app API response types */
interface GrepHit {
	owner_id: string;
	repo: string;
	branch: string;
	path: string;
	content: {
		snippet: string;
	};
	total_matches: string;
}

interface GrepFacetBucket {
	val: string;
	count: number;
	owner_id?: string;
}

interface GrepResponse {
	time: number;
	facets: {
		lang?: { buckets: GrepFacetBucket[] };
		repo?: { buckets: GrepFacetBucket[] };
		path?: { buckets: GrepFacetBucket[] };
	};
	hits: {
		total: number;
		hits: GrepHit[];
	};
}

/** Make request to grep.app API with timeout */
async function grepRequest(
	endpoint: "/search",
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<GrepResponse> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	if (signal) {
		if (signal.aborted) {
			clearTimeout(timeoutId);
			throw new Error("Request aborted by user");
		}
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	const queryString = new URLSearchParams(params).toString();
	const url = `${GREP_API_BASE}${endpoint}?${queryString}`;

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`grep.app API error (${response.status}): ${errorText}`);
		}

		return response.json() as Promise<GrepResponse>;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Strip HTML tags from snippet to get clean code */
function stripHtml(html: string): string {
	// Remove HTML tags
	let text = html.replace(/<[^>]+>/g, "");
	// Replace HTML entities
	text = text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ");
	return text;
}

/** Format snippet for display, preserving structure */
function formatSnippet(snippet: string): string {
	const text = stripHtml(snippet);
	// Remove extra blank lines while preserving code structure
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

/** Format search results */
function formatResults(response: GrepResponse, from: number): string {
	const { hits, facets } = response;

	if (hits.hits.length === 0) {
		return "No results found.";
	}

	let output = "";

	// Summary
	output += `## Results ${from + 1}-${from + hits.hits.length} of ${hits.total.toLocaleString()}\n\n`;

	// Language filters
	if (facets.lang?.buckets?.length) {
		output += "### Languages\n";
		const langs = facets.lang.buckets.slice(0, 8);
		output += langs.map((l) => `${l.val} (${l.count.toLocaleString()})`).join(" | ");
		output += "\n\n";
	}

	// Code results
	for (const hit of hits.hits) {
		const [owner, repo] = hit.repo.split("/");
		const githubUrl = `https://github.com/${hit.repo}/blob/${hit.branch}/${hit.path}`;

		output += `### ${hit.path}\n`;
		output += `**Repository:** ${hit.repo} (${hit.branch})\n`;
		output += `**URL:** ${githubUrl}\n`;
		output += `**Matches:** ${hit.total_matches}\n\n`;

		// Code snippet
		const code = formatSnippet(hit.content.snippet);
		const lang = hit.path.split(".").pop() || "";
		output += "```" + lang + "\n";
		output += code;
		output += "\n```\n\n";
		output += "---\n\n";
	}

	return output.trim();
}

/** Main extension entry point */
export default function (pi: ExtensionAPI) {
	// Register grep_code_search tool
	pi.registerTool({
		name: "grep_code_search",
		label: "Grep Code Search",
		description: `Search code across millions of GitHub repositories using grep.app.

Returns code snippets with syntax highlighting, file paths, and direct GitHub links.
Great for finding real-world usage examples, implementation patterns, and reference code.

Parameters:
- query: Search query (required) - supports regex patterns
- from: Result offset for pagination (default: 0, returns 10 results per page)

Search tips:
- Use specific function names: "useEffect cleanup"
- Filter by path: "config path:webpack"
- Language is auto-detected from file extension
- Results include syntax-highlighted snippets with line numbers`,

		parameters: Type.Object({
			query: Type.String({ description: "Search query (supports regex)" }),
			from: Type.Optional(
				Type.Number({ description: "Result offset for pagination", minimum: 0, default: 0 }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const from = params.from ?? 0;

			try {
				onUpdate?.({ type: "progress", message: `Searching for "${params.query}"...` });

				const response = await grepRequest(
					"/search",
					{
						q: params.query,
						from: String(from),
					},
					signal,
				);

				const formatted = formatResults(response, from);

				const output = [
					`## Grep.app Search: "${params.query}"`,
					`Query time: ${response.time}ms`,
					"",
					formatted,
				].join("\n");

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

		renderCall(args, theme) {
			const text = `${theme.bold("grep_code_search")}: "${args.query.slice(0, 40)}${args.query.length > 40 ? "..." : ""}"`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			if (result.details?.error) {
				return new Text(theme.error(`Error: ${result.details.error}`), 0, 0);
			}

			// Type guard for GrepResponse
			const isGrepResponse = (data: unknown): data is GrepResponse => {
				if (typeof data !== "object" || data === null) return false;
				const resp = data as Record<string, unknown>;
				return (
					typeof resp.time === "number" &&
					typeof resp.hits === "object" &&
					resp.hits !== null &&
					Array.isArray((resp.hits as { hits?: unknown[] }).hits)
				);
			};

			const response = isGrepResponse(result.details?.response)
				? result.details.response
				: undefined;
			if (!response) return new Text("No results", 0, 0);

			const lines: string[] = [];
			lines.push(`${response.hits.total.toLocaleString()} matches`);
			lines.push(`${response.time}ms`);

			// Show top language if available
			if (response.facets.lang?.buckets?.length) {
				const topLang = response.facets.lang.buckets[0];
				lines.push(`${topLang.val}: ${topLang.count.toLocaleString()}`);
			}

			return new Text(lines.join(" | "), 0, 0);
		},
	});
}
