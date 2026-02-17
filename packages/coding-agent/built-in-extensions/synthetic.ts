import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "synthetic-quota";
const MIN_REFRESH_INTERVAL_MS = 30000; // 30 seconds

// Quota API response type
interface QuotaResponse {
	subscription: {
		limit: number;
		requests: number;
		renewsAt: string;
	};
}

// Get color name based on usage
function getColorForPercent(percent: number): ThemeColor {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

/**
 * Synthetic provider extension for pi
 * Displays real-time quota status in the TUI status bar
 */
export default function (pi: ExtensionAPI) {
	let lastUpdate = 0;

	// Fetch and update quota status with rate limiting
	async function updateQuotaStatus(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;

		// Only show when using synthetic model
		const model = ctx.model;
		if (model?.provider !== "synthetic") {
			ctx.ui.setStatus(STATUS_KEY, "");
			return;
		}

		// Rate limit quota API calls
		if (Date.now() - lastUpdate < MIN_REFRESH_INTERVAL_MS) {
			return;
		}

		const apiKey = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
		if (!apiKey) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "syn: no key"));
			return;
		}

		try {
			const response = await fetch("https://api.synthetic.new/v2/quotas", {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
			});

			if (!response.ok) {
				ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "syn: unavailable"));
				return;
			}

			const data = (await response.json()) as QuotaResponse;
			const { subscription } = data;
			const used = subscription.requests;
			const limit = subscription.limit;
			const percent = Math.round((used / limit) * 100);
			const color = getColorForPercent(percent);

			// Format reset time (e.g., "2h" or "1d" or "45m")
			const renewsAt = new Date(subscription.renewsAt);
			const now = new Date();
			const diffMs = renewsAt.getTime() - now.getTime();
			const diffMinutes = Math.floor(diffMs / (1000 * 60));
			const diffHours = Math.floor(diffMinutes / 60);
			const diffDays = Math.floor(diffHours / 24);
			let resetText: string;
			if (diffDays > 0) {
				resetText = `${diffDays}d`;
			} else if (diffHours > 0) {
				resetText = `${diffHours}h`;
			} else {
				resetText = `${diffMinutes}m`;
			}

			const statusText = `syn: ${used}/${limit} (${theme.fg(color, `${percent}%`)}) · ${resetText}`;
			ctx.ui.setStatus(STATUS_KEY, statusText);
			lastUpdate = Date.now();
		} catch (err) {
			console.error("[synthetic] quota error:", err);
			ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "syn: error"));
		}
	}

	// Update on session start
	pi.on("session_start", async (_event, ctx) => {
		await updateQuotaStatus(ctx);
	});

	// Update on turn end
	pi.on("turn_end", async (_event, ctx) => {
		await updateQuotaStatus(ctx);
	});

	// Update when model changes
	pi.on("model_select", async (_event, ctx) => {
		await updateQuotaStatus(ctx);
	});

	// Refresh quota when agent starts with synthetic
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.model?.provider === "synthetic") {
			await updateQuotaStatus(ctx);
		}
	});

	// Clear status on session shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, "");
		lastUpdate = 0;
	});
}
