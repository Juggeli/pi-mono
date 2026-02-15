// Context type available at runtime, not in stub types
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Context = any;

const STATUS_KEY = "openrouter-credits";
const MIN_REFRESH_INTERVAL_MS = 60000; // 60 seconds

// OpenRouter API response types
interface OpenRouterCreditsResponse {
  data: {
    total_credits: number;
    total_usage: number;
  };
}

/**
 * OpenRouter provider extension for pi
 * Provides access to models via OpenRouter API with credits display
 */
export default function (pi: ExtensionAPI) {
  let lastUpdate = 0;

  // Register the OpenRouter provider
  pi.registerProvider("openrouter", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "OPENROUTER_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "minimax/minimax-m2.5",
        name: "MiniMax M2.5",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.2, output: 1.1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 8192
      }
    ]
  });

  // Format currency for display
  function formatCurrency(cents: number): string {
    if (cents >= 100) {
      return `$${(cents / 100).toFixed(2)}`;
    }
    return `${cents.toFixed(1)}¢`;
  }

  // Get color based on remaining credits
  function getColorForRemaining(remaining: number): string {
    if (remaining < 5) return "error";
    if (remaining < 20) return "warning";
    return "success";
  }

  // Fetch and update credits status
  async function updateCreditsStatus(ctx: Context) {
    const theme = ctx.ui.theme;
    const apiKey = process.env.OPENROUTER_API_KEY;

    // Only show when using openrouter model
    const model = ctx.model;
    if (model?.provider !== "openrouter") {
      ctx.ui.setStatus(STATUS_KEY, "");
      return;
    }

    // Rate limit API calls
    if (Date.now() - lastUpdate < MIN_REFRESH_INTERVAL_MS) {
      return;
    }

    if (!apiKey) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "or: no key"));
      return;
    }

    try {
      const response = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "or: unavailable"));
        return;
      }

      const data: OpenRouterCreditsResponse = await response.json();
      const totalCredits = data.data.total_credits;
      const totalUsage = data.data.total_usage;
      const remaining = totalCredits - totalUsage;

      const color = getColorForRemaining(remaining);
      const statusText = `or: ${theme.fg(color, formatCurrency(remaining))}`;

      ctx.ui.setStatus(STATUS_KEY, statusText);
      lastUpdate = Date.now();
    } catch (err) {
      console.error("[openrouter] credits error:", err);
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "or: error"));
    }
  }

  // Update on session start
  pi.on("session_start", async (_event, ctx) => {
    await updateCreditsStatus(ctx);
  });

  // Update on turn end (check credits after usage)
  pi.on("turn_end", async (_event, ctx) => {
    await updateCreditsStatus(ctx);
  });

  // Update when model changes
  pi.on("model_select", async (_event, ctx) => {
    await updateCreditsStatus(ctx);
  });

  // Refresh when agent starts with openrouter
  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.model?.provider === "openrouter") {
      await updateCreditsStatus(ctx);
    }
  });

  // Clear status on session end
  pi.on("session_end", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, "");
    lastUpdate = 0;
  });
}
