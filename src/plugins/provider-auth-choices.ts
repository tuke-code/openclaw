import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../shared/record-coerce.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type ProviderAuthChoiceMetadata = {
  pluginId: string;
  providerId: string;
  methodId: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  deprecatedChoiceIds?: string[];
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  onboardingFeatured?: boolean;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: ("text-inference" | "image-generation" | "music-generation")[];
};

export type ProviderOnboardAuthFlag = {
  optionKey: string;
  authChoice: string;
  cliFlag: string;
  cliOption: string;
  description: string;
};

type ProviderAuthChoiceCandidate = ProviderAuthChoiceMetadata & {
  origin?: PluginOrigin;
};
type ProviderOnboardAuthFlagCandidate = ProviderAuthChoiceCandidate & {
  optionKey: string;
  cliFlag: string;
  cliOption: string;
};
type ManifestProviderAuthChoiceParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
};

const PROVIDER_AUTH_CHOICE_ORIGIN_PRIORITY: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  bundled: 1,
  global: 2,
  workspace: 3,
};
const DESCRIPTOR_LABEL_ACRONYMS: ReadonlyMap<string, string> = new Map([
  ["api", "API"],
  ["jwt", "JWT"],
  ["oauth", "OAuth"],
  ["oidc", "OIDC"],
  ["pkce", "PKCE"],
  ["saml", "SAML"],
  ["sso", "SSO"],
] as const);

function resolveProviderAuthChoiceOriginPriority(origin: PluginOrigin | undefined): number {
  if (!origin) {
    return Number.MAX_SAFE_INTEGER;
  }
  return PROVIDER_AUTH_CHOICE_ORIGIN_PRIORITY[origin] ?? Number.MAX_SAFE_INTEGER;
}

function isReadableRecord(value: unknown): value is Record<string, unknown> {
  try {
    return isRecord(value);
  } catch {
    return false;
  }
}

function readRecordValue(record: unknown, key: string): unknown {
  if (!isReadableRecord(record)) {
    return undefined;
  }
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function copyArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      continue;
    }
  }
  return entries;
}

function readStringField(record: unknown, key: string): string | undefined {
  const value = readRecordValue(record, key);
  return typeof value === "string" ? value : undefined;
}

function readNumberField(record: unknown, key: string): number | undefined {
  const value = readRecordValue(record, key);
  return typeof value === "number" ? value : undefined;
}

function readBooleanField(record: unknown, key: string): boolean | undefined {
  const value = readRecordValue(record, key);
  return typeof value === "boolean" ? value : undefined;
}

function readStringArrayField(record: unknown, key: string): string[] | undefined {
  const values = copyArrayEntries(readRecordValue(record, key)).filter(
    (entry): entry is string => typeof entry === "string",
  );
  return values.length > 0 ? values : undefined;
}

function readPluginOrigin(record: unknown): PluginOrigin | undefined {
  const origin = readStringField(record, "origin");
  return origin === "config" ||
    origin === "bundled" ||
    origin === "global" ||
    origin === "workspace"
    ? origin
    : undefined;
}

function readManifestPluginRecords(registry: unknown): unknown[] {
  return copyArrayEntries(readRecordValue(registry, "plugins")).filter(isReadableRecord);
}

function readProviderAuthChoiceRecords(plugin: unknown): unknown[] {
  return copyArrayEntries(readRecordValue(plugin, "providerAuthChoices")).filter(isReadableRecord);
}

function toProviderAuthChoiceCandidate(params: {
  pluginId: string;
  origin: PluginOrigin | undefined;
  choice: unknown;
}): ProviderAuthChoiceCandidate | undefined {
  const { pluginId, origin, choice } = params;
  const providerId = readStringField(choice, "provider");
  const methodId = readStringField(choice, "method");
  const choiceId = readStringField(choice, "choiceId");
  if (!providerId || !methodId || !choiceId) {
    return undefined;
  }
  const choiceLabel = readStringField(choice, "choiceLabel");
  const choiceHint = readStringField(choice, "choiceHint");
  const assistantPriority = readNumberField(choice, "assistantPriority");
  const assistantVisibility = readStringField(choice, "assistantVisibility");
  const deprecatedChoiceIds = readStringArrayField(choice, "deprecatedChoiceIds");
  const groupId = readStringField(choice, "groupId");
  const groupLabel = readStringField(choice, "groupLabel");
  const groupHint = readStringField(choice, "groupHint");
  const optionKey = readStringField(choice, "optionKey");
  const cliFlag = readStringField(choice, "cliFlag");
  const cliOption = readStringField(choice, "cliOption");
  const cliDescription = readStringField(choice, "cliDescription");
  const onboardingScopes = readStringArrayField(choice, "onboardingScopes")?.filter(
    (scope): scope is "text-inference" | "image-generation" | "music-generation" =>
      scope === "text-inference" || scope === "image-generation" || scope === "music-generation",
  );
  return {
    pluginId,
    origin,
    providerId,
    methodId,
    choiceId,
    choiceLabel: choiceLabel ?? choiceId,
    ...(choiceHint ? { choiceHint } : {}),
    ...(assistantPriority !== undefined ? { assistantPriority } : {}),
    ...(assistantVisibility === "visible" || assistantVisibility === "manual-only"
      ? { assistantVisibility }
      : {}),
    ...(deprecatedChoiceIds ? { deprecatedChoiceIds } : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupLabel ? { groupLabel } : {}),
    ...(groupHint ? { groupHint } : {}),
    ...(readBooleanField(choice, "onboardingFeatured") ? { onboardingFeatured: true } : {}),
    ...(optionKey ? { optionKey } : {}),
    ...(cliFlag ? { cliFlag } : {}),
    ...(cliOption ? { cliOption } : {}),
    ...(cliDescription ? { cliDescription } : {}),
    ...(onboardingScopes && onboardingScopes.length > 0 ? { onboardingScopes } : {}),
  };
}

function formatDescriptorLabel(value: string): string {
  return sanitizeForLog(value)
    .trim()
    .split(/[-_\s]+/gu)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      const acronym = DESCRIPTOR_LABEL_ACRONYMS.get(lower);
      if (acronym) {
        return acronym;
      }
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function normalizeManifestAuthDescriptorId(value: string): string {
  return sanitizeForLog(value).trim();
}

function toSetupProviderAuthChoiceCandidate(params: {
  pluginId: string;
  origin: PluginOrigin | undefined;
  providerId: string;
  methodId: string;
}): ProviderAuthChoiceCandidate {
  const providerLabel = formatDescriptorLabel(params.providerId);
  const methodLabel = formatDescriptorLabel(params.methodId);
  const choiceLabel =
    params.methodId === "api-key" ? `${providerLabel} API key` : `${providerLabel} ${methodLabel}`;
  return {
    pluginId: params.pluginId,
    origin: params.origin,
    providerId: params.providerId,
    methodId: params.methodId,
    choiceId: `${params.providerId}-${params.methodId}`,
    choiceLabel,
    groupId: params.providerId,
    groupLabel: providerLabel,
  };
}

function listSetupProviderAuthChoiceCandidates(params: {
  plugin: unknown;
  pluginId: string;
  origin: PluginOrigin | undefined;
}) {
  const setup = readRecordValue(params.plugin, "setup");
  if (
    readRecordValue(setup, "requiresRuntime") !== false &&
    readStringField(params.plugin, "setupSource")
  ) {
    return [];
  }
  const explicitProviderMethods = new Set(
    readProviderAuthChoiceRecords(params.plugin)
      .map((choice) => {
        const provider = readStringField(choice, "provider");
        const method = readStringField(choice, "method");
        return provider && method ? `${provider}::${method}` : undefined;
      })
      .filter((entry): entry is string => Boolean(entry)),
  );
  return copyArrayEntries(readRecordValue(setup, "providers")).flatMap((provider) => {
    const providerId = normalizeManifestAuthDescriptorId(readStringField(provider, "id") ?? "");
    if (!providerId) {
      return [];
    }
    return copyArrayEntries(readRecordValue(provider, "authMethods"))
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalizeManifestAuthDescriptorId)
      .filter(Boolean)
      .filter((methodId) => !explicitProviderMethods.has(`${providerId}::${methodId}`))
      .map((methodId) =>
        toSetupProviderAuthChoiceCandidate({
          pluginId: params.pluginId,
          origin: params.origin,
          providerId,
          methodId,
        }),
      );
  });
}

function stripChoiceOrigin(choice: ProviderAuthChoiceCandidate): ProviderAuthChoiceMetadata {
  const { origin: _origin, ...metadata } = choice;
  return metadata;
}

function resolveManifestProviderAuthChoiceCandidates(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
}): ProviderAuthChoiceCandidate[] {
  const metadataSnapshot = loadManifestMetadataSnapshot({
    config: params?.config ?? {},
    workspaceDir: params?.workspaceDir,
    env: params?.env ?? process.env,
  });
  const registry = metadataSnapshot.manifestRegistry;
  const normalizedConfig = normalizePluginsConfig(params?.config?.plugins);
  return readManifestPluginRecords(registry).flatMap((plugin) => {
    const pluginId = readStringField(plugin, "id");
    const origin = readPluginOrigin(plugin);
    if (!pluginId) {
      return [];
    }
    if (params?.includeUntrustedWorkspacePlugins === false && !origin) {
      return [];
    }
    if (
      origin === "workspace" &&
      params?.includeUntrustedWorkspacePlugins === false &&
      !resolveEffectiveEnableState({
        id: pluginId,
        origin,
        config: normalizedConfig,
        rootConfig: params?.config,
      }).enabled
    ) {
      return [];
    }
    const choices: ProviderAuthChoiceCandidate[] = [];
    for (const choice of readProviderAuthChoiceRecords(plugin)) {
      const candidate = toProviderAuthChoiceCandidate({
        pluginId,
        origin,
        choice,
      });
      if (candidate) {
        choices.push(candidate);
      }
    }
    choices.push(...listSetupProviderAuthChoiceCandidates({ plugin, pluginId, origin }));
    return choices;
  });
}

function pickPreferredManifestAuthChoice(
  candidates: readonly ProviderAuthChoiceCandidate[],
): ProviderAuthChoiceCandidate | undefined {
  let preferred: ProviderAuthChoiceCandidate | undefined;
  for (const candidate of candidates) {
    if (!preferred) {
      preferred = candidate;
      continue;
    }
    if (
      resolveProviderAuthChoiceOriginPriority(candidate.origin) <
      resolveProviderAuthChoiceOriginPriority(preferred.origin)
    ) {
      preferred = candidate;
    }
  }
  return preferred;
}

function resolvePreferredManifestAuthChoicesByChoiceId(
  candidates: readonly ProviderAuthChoiceCandidate[],
): ProviderAuthChoiceCandidate[] {
  const preferredByChoiceId = new Map<string, ProviderAuthChoiceCandidate>();
  for (const candidate of candidates) {
    const normalizedChoiceId = candidate.choiceId.trim();
    if (!normalizedChoiceId) {
      continue;
    }
    const existing = preferredByChoiceId.get(normalizedChoiceId);
    if (
      !existing ||
      resolveProviderAuthChoiceOriginPriority(candidate.origin) <
        resolveProviderAuthChoiceOriginPriority(existing.origin)
    ) {
      preferredByChoiceId.set(normalizedChoiceId, candidate);
    }
  }
  return [...preferredByChoiceId.values()];
}

function resolvePreferredManifestAuthChoiceMetadata(params: {
  config?: ManifestProviderAuthChoiceParams;
  matches: (choice: ProviderAuthChoiceCandidate) => boolean;
}): ProviderAuthChoiceMetadata | undefined {
  const candidates = resolveManifestProviderAuthChoiceCandidates(params.config).filter(
    params.matches,
  );
  const preferred = pickPreferredManifestAuthChoice(candidates);
  return preferred ? stripChoiceOrigin(preferred) : undefined;
}

export function resolveManifestProviderAuthChoices(
  params?: ManifestProviderAuthChoiceParams,
): ProviderAuthChoiceMetadata[] {
  return resolvePreferredManifestAuthChoicesByChoiceId(
    resolveManifestProviderAuthChoiceCandidates(params),
  ).map(stripChoiceOrigin);
}

export function resolveManifestProviderAuthChoice(
  choiceId: string,
  params?: ManifestProviderAuthChoiceParams,
): ProviderAuthChoiceMetadata | undefined {
  const normalized = choiceId.trim();
  if (!normalized) {
    return undefined;
  }
  return resolvePreferredManifestAuthChoiceMetadata({
    config: params,
    matches: (choice) => choice.choiceId === normalized,
  });
}

export function resolveManifestProviderApiKeyChoice(params: {
  providerId: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
}): ProviderAuthChoiceMetadata | undefined {
  const normalizedProviderId = resolveProviderIdForAuth(params.providerId, params);
  if (!normalizedProviderId) {
    return undefined;
  }
  return resolvePreferredManifestAuthChoiceMetadata({
    config: params,
    matches: (choice) =>
      Boolean(choice.optionKey) &&
      resolveProviderIdForAuth(choice.providerId, params) === normalizedProviderId,
  });
}

export function resolveManifestDeprecatedProviderAuthChoice(
  choiceId: string,
  params?: ManifestProviderAuthChoiceParams,
): ProviderAuthChoiceMetadata | undefined {
  const normalized = choiceId.trim();
  if (!normalized) {
    return undefined;
  }
  return resolvePreferredManifestAuthChoiceMetadata({
    config: params,
    matches: (choice) => choice.deprecatedChoiceIds?.includes(normalized) === true,
  });
}

export function resolveManifestProviderOnboardAuthFlags(
  params?: ManifestProviderAuthChoiceParams,
): ProviderOnboardAuthFlag[] {
  const preferredByFlag = new Map<string, ProviderOnboardAuthFlagCandidate>();

  for (const choice of resolveManifestProviderAuthChoiceCandidates(params)) {
    if (!choice.optionKey || !choice.cliFlag || !choice.cliOption) {
      continue;
    }
    const normalizedChoice: ProviderOnboardAuthFlagCandidate = {
      ...choice,
      optionKey: choice.optionKey,
      cliFlag: choice.cliFlag,
      cliOption: choice.cliOption,
    };
    const dedupeKey = `${choice.optionKey}::${choice.cliFlag}`;
    const existing = preferredByFlag.get(dedupeKey);
    if (
      existing &&
      resolveProviderAuthChoiceOriginPriority(normalizedChoice.origin) >=
        resolveProviderAuthChoiceOriginPriority(existing.origin)
    ) {
      continue;
    }
    preferredByFlag.set(dedupeKey, normalizedChoice);
  }

  const flags: ProviderOnboardAuthFlag[] = [];
  for (const choice of preferredByFlag.values()) {
    flags.push({
      optionKey: choice.optionKey,
      authChoice: choice.choiceId,
      cliFlag: choice.cliFlag,
      cliOption: choice.cliOption,
      description: choice.cliDescription ?? choice.choiceLabel,
    });
  }
  return flags;
}
