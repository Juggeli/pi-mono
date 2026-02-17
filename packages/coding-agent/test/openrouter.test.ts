import { beforeEach, describe, expect, it, vi } from "vitest";
import openrouterExtension from "../built-in-extensions/openrouter.js";

describe("openrouter extension", () => {
	let mockPi: any;
	let eventHandlers: Record<string, (...args: unknown[]) => Promise<void>>;
	let registeredProvider: any;

	function createMockCtx(overrides: Record<string, any> = {}) {
		return {
			model: overrides.model ?? { provider: "openrouter" },
			ui: {
				theme: {
					fg: (_color: string, text: string) => text,
				},
				setStatus: vi.fn(),
			},
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue("test-api-key"),
			},
			...overrides,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		eventHandlers = {};

		mockPi = {
			registerProvider: vi.fn((name: string, config: any) => {
				registeredProvider = { name, config };
			}),
			on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => {
				eventHandlers[event] = handler;
			}),
		};

		openrouterExtension(mockPi);
	});

	describe("provider registration", () => {
		it("registers openrouter provider", () => {
			expect(mockPi.registerProvider).toHaveBeenCalledWith("openrouter", expect.any(Object));
			expect(registeredProvider.name).toBe("openrouter");
		});

		it("configures correct base URL", () => {
			expect(registeredProvider.config.baseUrl).toBe("https://openrouter.ai/api/v1");
		});

		it("uses openai-completions API", () => {
			expect(registeredProvider.config.api).toBe("openai-completions");
		});

		it("registers at least one model", () => {
			expect(registeredProvider.config.models.length).toBeGreaterThan(0);
		});

		it("registers MiniMax M2.5 model", () => {
			const model = registeredProvider.config.models[0];
			expect(model.id).toBe("minimax/minimax-m2.5");
			expect(model.name).toBe("MiniMax M2.5");
			expect(model.reasoning).toBe(true);
		});
	});

	describe("event handlers", () => {
		it("registers all expected event handlers", () => {
			expect(eventHandlers).toHaveProperty("session_start");
			expect(eventHandlers).toHaveProperty("turn_end");
			expect(eventHandlers).toHaveProperty("model_select");
			expect(eventHandlers).toHaveProperty("agent_start");
			expect(eventHandlers).toHaveProperty("session_shutdown");
		});

		it("does NOT register session_end (invalid event)", () => {
			expect(eventHandlers).not.toHaveProperty("session_end");
		});
	});

	describe("credits status updates", () => {
		it("clears status when provider is not openrouter", async () => {
			const ctx = createMockCtx({ model: { provider: "anthropic" } });
			await eventHandlers.session_start({}, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", "");
		});

		it("clears status when model is undefined", async () => {
			const ctx = createMockCtx({ model: undefined });
			await eventHandlers.session_start({}, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", "");
		});

		it("shows 'no key' when API key is not available", async () => {
			const ctx = createMockCtx();
			ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue(undefined);

			await eventHandlers.session_start({}, ctx);

			expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("openrouter");
			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", "or: no key");
		});

		it("fetches credits and displays remaining", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						data: {
							total_credits: 10.0,
							total_usage: 3.5,
						},
					}),
			});
			global.fetch = mockFetch;

			const ctx = createMockCtx();
			await eventHandlers.session_start({}, ctx);

			expect(mockFetch).toHaveBeenCalledWith(
				"https://openrouter.ai/api/v1/credits",
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer test-api-key",
					}),
				}),
			);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", expect.stringContaining("or:"));
			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", expect.stringContaining("$6.50"));
		});

		it("formats small amounts as cents", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						data: {
							total_credits: 1.0,
							total_usage: 0.95,
						},
					}),
			});

			const ctx = createMockCtx();
			await eventHandlers.session_start({}, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", expect.stringContaining("5.0¢"));
		});

		it("handles API error gracefully", async () => {
			global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

			const ctx = createMockCtx();
			await eventHandlers.session_start({}, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", "or: unavailable");
		});

		it("handles network error gracefully", async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

			const ctx = createMockCtx();
			await eventHandlers.session_start({}, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", "or: error");
		});

		it("rate limits API calls", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						data: { total_credits: 10.0, total_usage: 5.0 },
					}),
			});
			global.fetch = mockFetch;

			const ctx = createMockCtx();

			// First call should fetch
			await eventHandlers.session_start({}, ctx);
			expect(mockFetch).toHaveBeenCalledTimes(1);

			// Second call within rate limit should be skipped
			await eventHandlers.turn_end({}, ctx);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});

	describe("session_shutdown", () => {
		it("clears status and resets timer", async () => {
			const ctx = createMockCtx();
			await eventHandlers.session_shutdown({}, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", "");
		});
	});

	describe("agent_start", () => {
		it("updates credits when provider is openrouter", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						data: { total_credits: 10.0, total_usage: 2.0 },
					}),
			});

			const ctx = createMockCtx();
			await eventHandlers.agent_start({}, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("openrouter-credits", expect.stringContaining("$8.00"));
		});

		it("does not update when provider is not openrouter", async () => {
			const mockFetch = vi.fn();
			global.fetch = mockFetch;

			const ctx = createMockCtx({ model: { provider: "anthropic" } });
			await eventHandlers.agent_start({}, ctx);

			// agent_start checks provider before calling updateCreditsStatus, so nothing happens
			expect(mockFetch).not.toHaveBeenCalled();
			expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		});
	});
});
