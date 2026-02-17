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

/** Unified details type for tool results */
interface GrepSearchDetails {
	error?: string;
	response?: GrepResponse;
}

/** Search tool parameters */
interface SearchParams {
	query: string;
	from?: number;
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

		return (await response.json()) as GrepResponse;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Strip HTML tags from snippet to get clean code */
function stripHtml(html: string): string {
	let text = html.replace(/<[^>]+>/g, "");
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

	output += `## Results ${from + 1}-${from + hits.hits.length} of ${hits.total.toLocaleString()}\n\n`;

	if (facets.lang?.buckets?.length) {
		output += "### Languages\n";
		const langs = facets.lang.buckets.slice(0, 8);
		output += langs.map((l) => `${l.val} (${l.count.toLocaleString()})`).join(" | ");
		output += "\n\n";
	}

	for (const hit of hits.hits) {
		const githubUrl = `https://github.com/${hit.repo}/blob/${hit.branch}/${hit.path}`;

		output += `### ${hit.path}\n`;
		output += `**Repository:** ${hit.repo} (${hit.branch})\n`;
		output += `**URL:** ${githubUrl}\n`;
		output += `**Matches:** ${hit.total_matches}\n\n`;

		const code = formatSnippet(hit.content.snippet);
		const lang = hit.path.split(".").pop() || "";
		output += `\`\`\`${lang}\n`;
		output += code;
		output += "\n```\n\n";
		output += "---\n\n";
	}

	return output.trim();
}

/** Type guard for GrepResponse */
function isGrepResponse(data: unknown): data is GrepResponse {
	if (typeof data !== "object" || data === null) return false;
	const resp = data as Record<string, unknown>;
	return (
		typeof resp.time === "number" &&
		typeof resp.hits === "object" &&
		resp.hits !== null &&
		Array.isArray((resp.hits as { hits?: unknown[] }).hits)
	);
}

/** Main extension entry point */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grep_code_search",
		label: "Grep Code Search",
		description: `Search code across millions of GitHub repositories using grep.app.

Returns code snippets with syntax highlighting, file paths, and direct GitHub links.
Great for finding real-world usage examples, implementation patterns, and reference code.

Parameters:
- query: Search query (required) - supports regex patterns
- from: Result offset for pagination (default: 0, returns ${DEFAULT_PER_PAGE} results per page)

Search tips:
- Use specific function names: "useEffect cleanup"
- Filter by path: "config path:webpack"
- Language is auto-detected from file extension
- Results include syntax-highlighted snippets with line numbers`,
		shortDescription: "Search code across GitHub repos via grep.app",
		systemGuidelines: [
			"Use grep_code_search to find real-world usage examples and implementation patterns across GitHub",
		],

		parameters: Type.Object({
			query: Type.String({ description: "Search query (supports regex)" }),
			from: Type.Optional(Type.Number({ description: "Result offset for pagination", minimum: 0, default: 0 })),
		}),

		async execute(
			_toolCallId: string,
			params: SearchParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const from = params.from ?? 0;

			try {
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
					details: { response } as GrepSearchDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { error: message } as GrepSearchDetails,
				};
			}
		},

		renderCall(args, theme) {
			const params = args as unknown as SearchParams;
			const query = params.query ?? "";
			const text = `${theme.bold("grep_code_search")}: "${query.slice(0, 40)}${query.length > 40 ? "..." : ""}"`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as GrepSearchDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const response = isGrepResponse(details?.response) ? details.response : undefined;
			if (!response) return new Text("No results", 0, 0);

			const lines: string[] = [];
			lines.push(`${response.hits.total.toLocaleString()} matches`);
			lines.push(`${response.time}ms`);

			if (response.facets.lang?.buckets?.length) {
				const topLang = response.facets.lang.buckets[0];
				lines.push(`${topLang.val}: ${topLang.count.toLocaleString()}`);
			}

			return new Text(lines.join(" | "), 0, 0);
		},
	});
}
