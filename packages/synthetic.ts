import type { ExtensionAPI, Context } from "@mariozechner/pi-coding-agent";

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
function getColorForPercent(percent: number): string {
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

  // Register the synthetic provider
  pi.registerProvider("synthetic", {
    baseUrl: "https://api.synthetic.new/openai/v1",
    apiKey: "SYNTHETIC_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "hf:nvidia/Kimi-K2.5-NVFP4",
        name: "Kimi-K2.5-NVFP4",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 16384
      }
    ]
  });

  // Fetch and update quota status with rate limiting
  async function updateQuotaStatus(ctx: Context) {
    const theme = ctx.ui.theme;
    const apiKey = process.env.SYNTHETIC_API_KEY;

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

    if (!apiKey) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "syn: no key"));
      return;
    }

    try {
      const response = await fetch("https://api.synthetic.new/v2/quotas", {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "syn: unavailable"));
        return;
      }

      const data: QuotaResponse = await response.json();
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

  // Clear status on session end
  pi.on("session_end", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, "");
    lastUpdate = 0;
  });
}
