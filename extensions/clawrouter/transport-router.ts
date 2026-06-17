import type { ProviderRouteModelTransportContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveApiKeyForProvider,
  resolveProviderAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { getCachedLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "clawrouter";
const DEFAULT_ROOT_URL = "https://clawrouter.openclaw.ai";
const CATALOG_CACHE_TTL_MS = 60_000;

type CatalogRoute = {
  path: string;
  requestFormat: string;
  methods: string[];
};

type CatalogModel = {
  id: string;
  upstream: string;
  capabilities: string[];
};

type CatalogProvider = {
  id: string;
  openaiCompatible: boolean;
  nativeBaseUrl: string;
  routes: CatalogRoute[];
  models: CatalogModel[];
};

type ResolvedRoute = {
  api: "openai-responses" | "openai-completions" | "anthropic-messages" | "google-generative-ai";
  baseUrl: string;
  upstreamModel?: string;
};

const DEFAULT_ROUTE_KEY = "";
const preparedRoutes = new WeakMap<object, Map<string, ResolvedRoute>>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function parseCatalog(catalogBody: unknown): CatalogProvider[] {
  const providerRows = asRecord(catalogBody)?.providers;
  if (!Array.isArray(providerRows)) {
    throw new Error("ClawRouter catalog response must contain providers[]");
  }
  return providerRows.flatMap((providerValue): CatalogProvider[] => {
    const row = asRecord(providerValue);
    const id = readString(row?.id);
    const nativeBaseUrl = readString(row?.nativeBaseUrl);
    if (!id || !nativeBaseUrl || !nativeBaseUrl.startsWith("/v1/native/")) {
      return [];
    }
    const routes = Array.isArray(row?.routes)
      ? row.routes.flatMap((routeValue): CatalogRoute[] => {
          const route = asRecord(routeValue);
          const path = readString(route?.path);
          const requestFormat = readString(route?.requestFormat);
          return path && requestFormat
            ? [
                {
                  path,
                  requestFormat,
                  methods: readStrings(route?.methods).map((method) => method.toUpperCase()),
                },
              ]
            : [];
        })
      : [];
    const models = Array.isArray(row?.models)
      ? row.models.flatMap((modelValue): CatalogModel[] => {
          const model = asRecord(modelValue);
          const modelId = readString(model?.id);
          const upstream = readString(model?.upstream);
          return modelId && upstream
            ? [{ id: modelId, upstream, capabilities: readStrings(model?.capabilities) }]
            : [];
        })
      : [];
    return [
      { id, openaiCompatible: row?.openaiCompatible === true, nativeBaseUrl, routes, models },
    ];
  });
}

function normalizeRootUrl(value: string | undefined): string {
  const root = (value?.trim() || DEFAULT_ROOT_URL).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root.slice(0, -3) : root;
}

function readPluginConfig(config: ProviderRouteModelTransportContext["config"]): {
  baseUrl?: string;
  providers?: string[];
} {
  const entry = asRecord(config?.plugins?.entries?.[PROVIDER_ID]);
  const pluginConfig = asRecord(entry?.config);
  return {
    baseUrl: readString(pluginConfig?.baseUrl),
    providers: readStrings(pluginConfig?.providers),
  };
}

function isProviderEnabled(params: {
  configured: string[];
  canonicalProvider: string;
  catalogProvider: string;
}): boolean {
  if (params.configured.length === 0 || params.configured.includes("*")) {
    return true;
  }
  return (
    params.configured.includes(params.canonicalProvider) ||
    params.configured.includes(params.catalogProvider)
  );
}

function hasCapability(model: CatalogModel, capability: string): boolean {
  return model.capabilities.includes(capability);
}

function hasNativePostRoute(provider: CatalogProvider, requestFormat: string): boolean {
  return provider.routes.some(
    (route) => route.methods.includes("POST") && route.requestFormat === requestFormat,
  );
}

function resolveGoogleBaseUrl(rootUrl: string, provider: CatalogProvider): string | undefined {
  const googleRoute = provider.routes.find(
    (candidate) =>
      candidate.methods.includes("POST") &&
      candidate.requestFormat === "google.generate_content" &&
      candidate.path.includes(":streamGenerateContent"),
  );
  if (!googleRoute) {
    return undefined;
  }
  const modelIndex = googleRoute.path.indexOf("/models/${model}");
  return modelIndex > 0
    ? `${rootUrl}${provider.nativeBaseUrl}${googleRoute.path.slice(0, modelIndex)}`
    : undefined;
}

function buildRoute(params: {
  rootUrl: string;
  provider: CatalogProvider;
  model: CatalogModel;
}): ResolvedRoute | undefined {
  if (params.provider.openaiCompatible && hasCapability(params.model, "llm.responses")) {
    return {
      api: "openai-responses",
      baseUrl: `${params.rootUrl}/v1`,
      upstreamModel: params.model.upstream,
    };
  }
  if (params.provider.openaiCompatible && hasCapability(params.model, "llm.chat")) {
    return {
      api: "openai-completions",
      baseUrl: `${params.rootUrl}/v1`,
      upstreamModel: params.model.upstream,
    };
  }
  if (
    hasCapability(params.model, "llm.messages") &&
    hasNativePostRoute(params.provider, "anthropic.messages")
  ) {
    return {
      api: "anthropic-messages",
      baseUrl: `${params.rootUrl}${params.provider.nativeBaseUrl}`,
      upstreamModel: params.model.upstream,
    };
  }
  if (hasCapability(params.model, "llm.stream")) {
    const baseUrl = resolveGoogleBaseUrl(params.rootUrl, params.provider);
    if (baseUrl) {
      return {
        api: "google-generative-ai",
        baseUrl,
        upstreamModel: params.model.upstream,
      };
    }
  }
  return undefined;
}

function resolveRoute(params: {
  ctx: ProviderRouteModelTransportContext;
  rootUrl: string;
  providers: CatalogProvider[];
  configuredProviders: string[];
}): ResolvedRoute | undefined {
  const modelRefs = new Set([params.ctx.model.id, `${params.ctx.provider}/${params.ctx.model.id}`]);
  for (const provider of params.providers) {
    if (
      !isProviderEnabled({
        configured: params.configuredProviders,
        canonicalProvider: params.ctx.provider,
        catalogProvider: provider.id,
      })
    ) {
      continue;
    }
    const model = provider.models.find((candidate) => modelRefs.has(candidate.id));
    if (model) {
      return buildRoute({ rootUrl: params.rootUrl, provider, model });
    }
  }
  return undefined;
}

async function prepareRoute(ctx: ProviderRouteModelTransportContext): Promise<void> {
  // Catalog grants belong to a credential profile. A resolved catalog model can
  // be shared across concurrent runs, so retain a separate route per profile.
  const routes = preparedRoutes.get(ctx.model) ?? new Map<string, ResolvedRoute>();
  preparedRoutes.set(ctx.model, routes);
  const pluginConfig = readPluginConfig(ctx.config);
  const rootUrl = normalizeRootUrl(pluginConfig.baseUrl);
  const selectedProfileId = ctx.authProfileId?.startsWith(`${PROVIDER_ID}:`)
    ? ctx.authProfileId
    : undefined;
  const preferredProfile = ctx.preferredProfile?.startsWith(`${PROVIDER_ID}:`)
    ? ctx.preferredProfile
    : undefined;
  const profileCandidates = selectedProfileId
    ? [selectedProfileId]
    : [
        ...resolveProviderAuthProfileOrder({
          provider: PROVIDER_ID,
          cfg: ctx.config,
          ...(preferredProfile ? { preferredProfile } : {}),
          ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
        }),
        undefined,
      ];
  routes.delete(selectedProfileId ?? DEFAULT_ROUTE_KEY);

  for (const profileId of new Set(profileCandidates)) {
    const routeKey = profileId ?? DEFAULT_ROUTE_KEY;
    routes.delete(routeKey);
    try {
      const auth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: ctx.config,
        ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
        ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
        ...(profileId ? { profileId, lockedProfile: true } : {}),
      });
      const apiKey = auth.apiKey?.trim();
      if (!apiKey) {
        continue;
      }
      const catalogRows = await getCachedLiveProviderModelRows({
        providerId: PROVIDER_ID,
        endpoint: `${rootUrl}/v1/catalog`,
        apiKey,
        ttlMs: CATALOG_CACHE_TTL_MS,
        shouldCacheRows: (candidateRows) => candidateRows.length > 0,
        readRows: (body) => {
          const providers = asRecord(body)?.providers;
          return Array.isArray(providers) ? providers : [];
        },
        auditContext: "clawrouter-transport-routing",
      });
      const route = resolveRoute({
        ctx,
        rootUrl,
        providers: parseCatalog({ providers: catalogRows }),
        configuredProviders: pluginConfig.providers ?? [],
      });
      if (route) {
        routes.set(routeKey, route);
        if (!selectedProfileId) {
          routes.set(DEFAULT_ROUTE_KEY, route);
        }
        return;
      }
    } catch {
      // One unavailable credential must not block the next configured profile.
    }
  }
}

export function createClawRouterTransportRouter(): Pick<
  ProviderPlugin,
  "prepareModelTransportRoute" | "routeModelTransport"
> {
  return {
    prepareModelTransportRoute: async (ctx) => {
      try {
        await prepareRoute(ctx);
      } catch {
        // Catalog routing is fail-closed: canonical provider dispatch remains intact.
      }
    },
    routeModelTransport: (ctx) => {
      const route = preparedRoutes
        .get(ctx.model)
        ?.get(
          ctx.authProfileId?.startsWith(`${PROVIDER_ID}:`) ? ctx.authProfileId : DEFAULT_ROUTE_KEY,
        );
      if (!route) {
        return undefined;
      }
      return {
        ...ctx.model,
        api: route.api,
        baseUrl: route.baseUrl,
        dispatch: {
          authProvider: PROVIDER_ID,
          authHeader: "bearer",
          forceOpenClawTransport: true,
          ...(route.upstreamModel ? { upstreamModel: route.upstreamModel } : {}),
        },
      };
    },
  };
}
