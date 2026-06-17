import type { ProviderRouteModelTransportContext } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCachedLiveProviderModelRows: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileOrder: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", () => ({
  getCachedLiveProviderModelRows: mocks.getCachedLiveProviderModelRows,
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveProviderAuthProfileOrder: mocks.resolveProviderAuthProfileOrder,
}));

import { createClawRouterTransportRouter } from "./transport-router.js";

function buildContext(): ProviderRouteModelTransportContext {
  return {
    config: {
      plugins: {
        entries: {
          clawrouter: {
            enabled: true,
            config: {
              baseUrl: "https://router.example",
            },
          },
        },
      },
    },
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    model: {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_768,
    },
  };
}

describe("ClawRouter transport router", () => {
  beforeEach(() => {
    mocks.resolveApiKeyForProvider.mockReset();
    mocks.resolveProviderAuthProfileOrder.mockReset();
    mocks.getCachedLiveProviderModelRows.mockReset();
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "router-token",
      mode: "api-key",
    });
    mocks.resolveProviderAuthProfileOrder.mockReturnValue([]);
  });

  it("routes an entitled canonical model without creating a ClawRouter model id", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValue([
      {
        id: "anthropic",
        openaiCompatible: false,
        nativeBaseUrl: "/v1/native/anthropic",
        routes: [
          {
            path: "/v1/messages",
            methods: ["POST"],
            requestFormat: "anthropic.messages",
          },
        ],
        models: [
          {
            id: "anthropic/claude-sonnet-4-6",
            upstream: "claude-sonnet-4-6-20260217",
            capabilities: ["llm.messages"],
          },
        ],
      },
    ]);
    const router = createClawRouterTransportRouter();
    const ctx = buildContext();

    await router.prepareModelTransportRoute?.(ctx);
    const routed = router.routeModelTransport?.(ctx);

    expect(routed).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
      baseUrl: "https://router.example/v1/native/anthropic",
      dispatch: {
        authProvider: "clawrouter",
        authHeader: "bearer",
        forceOpenClawTransport: true,
        upstreamModel: "claude-sonnet-4-6-20260217",
      },
    });
    expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "clawrouter",
      cfg: ctx.config,
    });
    expect(mocks.getCachedLiveProviderModelRows).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://router.example/v1/catalog",
        apiKey: "router-token",
      }),
    );
  });

  it("fails closed when the catalog does not grant the canonical model", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValue([]);
    const router = createClawRouterTransportRouter();
    const ctx = buildContext();

    await router.prepareModelTransportRoute?.(ctx);

    expect(router.routeModelTransport?.(ctx)).toBeUndefined();
  });

  it("clears an earlier profile route when the next profile lacks the grant", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([
      {
        id: "anthropic",
        openaiCompatible: false,
        nativeBaseUrl: "/v1/native/anthropic",
        routes: [
          {
            path: "/v1/messages",
            methods: ["POST"],
            requestFormat: "anthropic.messages",
          },
        ],
        models: [
          {
            id: "anthropic/claude-sonnet-4-6",
            upstream: "claude-sonnet-4-6-20260217",
            capabilities: ["llm.messages"],
          },
        ],
      },
    ]);
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([]);
    const router = createClawRouterTransportRouter();
    const ctx = {
      ...buildContext(),
      authProfileId: "clawrouter:first",
    };

    await router.prepareModelTransportRoute?.(ctx);
    expect(router.routeModelTransport?.(ctx)).toBeDefined();

    ctx.authProfileId = "clawrouter:second";
    await router.prepareModelTransportRoute?.(ctx);

    expect(router.routeModelTransport?.(ctx)).toBeUndefined();
    expect(mocks.resolveApiKeyForProvider).toHaveBeenLastCalledWith({
      provider: "clawrouter",
      cfg: ctx.config,
      profileId: "clawrouter:second",
      lockedProfile: true,
    });
  });

  it("keeps concurrently prepared profile routes isolated on a shared model", async () => {
    mocks.resolveApiKeyForProvider.mockImplementation(async ({ profileId }) => ({
      apiKey: profileId === "clawrouter:one" ? "token-one" : "token-two",
      mode: "api-key",
    }));
    mocks.getCachedLiveProviderModelRows.mockImplementation(async ({ apiKey }) => [
      {
        id: "anthropic",
        openaiCompatible: false,
        nativeBaseUrl: "/v1/native/anthropic",
        routes: [
          {
            path: "/v1/messages",
            methods: ["POST"],
            requestFormat: "anthropic.messages",
          },
        ],
        models: [
          {
            id: "anthropic/claude-sonnet-4-6",
            upstream:
              apiKey === "token-one" ? "claude-sonnet-route-one" : "claude-sonnet-route-two",
            capabilities: ["llm.messages"],
          },
        ],
      },
    ]);
    const router = createClawRouterTransportRouter();
    const sharedModel = buildContext().model;
    const first = {
      ...buildContext(),
      model: sharedModel,
      authProfileId: "clawrouter:one",
    };
    const second = {
      ...buildContext(),
      model: sharedModel,
      authProfileId: "clawrouter:two",
    };

    await Promise.all([
      router.prepareModelTransportRoute?.(first),
      router.prepareModelTransportRoute?.(second),
    ]);

    expect(router.routeModelTransport?.(first)).toMatchObject({
      dispatch: { upstreamModel: "claude-sonnet-route-one" },
    });
    expect(router.routeModelTransport?.(second)).toMatchObject({
      dispatch: { upstreamModel: "claude-sonnet-route-two" },
    });
  });

  it("uses the catalog upstream id for OpenAI-compatible dispatch", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValue([
      {
        id: "openai",
        openaiCompatible: true,
        nativeBaseUrl: "/v1/native/openai",
        routes: [],
        models: [
          {
            id: "openai/gpt-5.5",
            upstream: "gpt-5.5-20260617",
            capabilities: ["llm.responses"],
          },
        ],
      },
    ]);
    const router = createClawRouterTransportRouter();
    const ctx = {
      ...buildContext(),
      provider: "openai",
      modelId: "gpt-5.5",
      model: {
        ...buildContext().model,
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
      },
    };

    await router.prepareModelTransportRoute?.(ctx);
    const routed = router.routeModelTransport?.(ctx);

    expect(routed).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://router.example/v1",
      dispatch: {
        upstreamModel: "gpt-5.5-20260617",
      },
    });
  });

  it("uses an explicitly selected ClawRouter profile for catalog access", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValue([]);
    const router = createClawRouterTransportRouter();
    const ctx = {
      ...buildContext(),
      authProfileId: "clawrouter:maintainer",
    };

    await router.prepareModelTransportRoute?.(ctx);

    expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "clawrouter",
      cfg: ctx.config,
      profileId: "clawrouter:maintainer",
      lockedProfile: true,
    });
  });

  it("probes configured ClawRouter profiles before canonical auth can win", async () => {
    mocks.resolveProviderAuthProfileOrder.mockReturnValue([
      "clawrouter:denied",
      "clawrouter:allowed",
    ]);
    mocks.resolveApiKeyForProvider.mockImplementation(async ({ profileId }) => ({
      apiKey: profileId === "clawrouter:allowed" ? "allowed-token" : "denied-token",
      mode: "api-key",
    }));
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([]);
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([
      {
        id: "anthropic",
        openaiCompatible: false,
        nativeBaseUrl: "/v1/native/anthropic",
        routes: [
          {
            path: "/v1/messages",
            methods: ["POST"],
            requestFormat: "anthropic.messages",
          },
        ],
        models: [
          {
            id: "anthropic/claude-sonnet-4-6",
            upstream: "claude-sonnet-4-6-20260217",
            capabilities: ["llm.messages"],
          },
        ],
      },
    ]);
    const router = createClawRouterTransportRouter();
    const ctx = buildContext();

    await router.prepareModelTransportRoute?.(ctx);

    expect(mocks.resolveProviderAuthProfileOrder).toHaveBeenCalledWith({
      provider: "clawrouter",
      cfg: ctx.config,
    });
    expect(mocks.resolveApiKeyForProvider).toHaveBeenNthCalledWith(1, {
      provider: "clawrouter",
      cfg: ctx.config,
      profileId: "clawrouter:denied",
      lockedProfile: true,
    });
    expect(mocks.resolveApiKeyForProvider).toHaveBeenNthCalledWith(2, {
      provider: "clawrouter",
      cfg: ctx.config,
      profileId: "clawrouter:allowed",
      lockedProfile: true,
    });
    expect(router.routeModelTransport?.(ctx)).toMatchObject({
      dispatch: {
        authProvider: "clawrouter",
      },
    });
  });
});
