import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { defaultSlotIdForKey } from "./slots.js";

export type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
    contextEngine?: string | null;
  };
  entries: Record<
    string,
    {
      enabled?: boolean;
      hooks?: {
        allowPromptInjection?: boolean;
        allowConversationAccess?: boolean;
        timeoutMs?: number;
        timeouts?: Record<string, number>;
      };
      subagent?: {
        allowModelOverride?: boolean;
        allowedModels?: string[];
        hasAllowedModelsConfig?: boolean;
      };
      llm?: {
        allowModelOverride?: boolean;
        allowedModels?: string[];
        hasAllowedModelsConfig?: boolean;
        allowAgentIdOverride?: boolean;
      };
      config?: unknown;
    }
  >;
};

export type NormalizePluginId = (id: string) => string;

export const identityNormalizePluginId: NormalizePluginId = (id) => id.trim();

const MAX_PLUGIN_CONFIG_LIST_ENTRIES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecordValue(record: unknown, key: string): unknown {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function hasRecordKey(record: unknown, key: string): boolean {
  if (!record || typeof record !== "object") {
    return false;
  }
  try {
    return Object.prototype.hasOwnProperty.call(record, key);
  } catch {
    return false;
  }
}

function copyArrayEntries(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const safeLength = Math.min(Math.max(0, length), MAX_PLUGIN_CONFIG_LIST_ENTRIES);
  const entries: unknown[] = [];
  for (let index = 0; index < safeLength; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      entries.push(undefined);
    }
  }
  return entries;
}

function copyRecordEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, value[key]]);
    } catch {
      // Skip unreadable plugin config fields; other readable config still applies.
    }
  }
  return entries;
}

function normalizeList(value: unknown, normalizePluginId: NormalizePluginId): string[] {
  const entries = copyArrayEntries(value);
  if (!entries) {
    return [];
  }
  return entries
    .map((entry) => (typeof entry === "string" ? normalizePluginId(entry) : ""))
    .filter(Boolean);
}

function normalizeArrayBackedTrimmedStringList(value: unknown): string[] | undefined {
  const entries = copyArrayEntries(value);
  if (!entries) {
    return undefined;
  }
  return entries.flatMap((entry) => {
    const normalized = normalizeOptionalString(entry);
    return normalized ? [normalized] : [];
  });
}

function normalizeSlotValue(value: unknown): string | null | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (normalizeOptionalLowercaseString(trimmed) === "none") {
    return null;
  }
  return trimmed;
}

function normalizeHookTimeoutMs(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 600_000
  ) {
    return undefined;
  }
  return value;
}

function normalizeHookTimeouts(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, number> = {};
  for (const [hookName, timeoutMs] of copyRecordEntries(value)) {
    const normalizedTimeoutMs = normalizeHookTimeoutMs(timeoutMs);
    if (normalizedTimeoutMs !== undefined) {
      normalized[hookName] = normalizedTimeoutMs;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePluginEntries(
  entries: unknown,
  normalizePluginId: NormalizePluginId,
): NormalizedPluginsConfig["entries"] {
  if (!isRecord(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of copyRecordEntries(entries)) {
    const normalizedKey = normalizePluginId(key);
    if (!normalizedKey) {
      continue;
    }
    if (!isRecord(value)) {
      normalized[normalizedKey] = {};
      continue;
    }
    const hooksRaw = readRecordValue(value, "hooks");
    const hooks = isRecord(hooksRaw)
      ? {
          allowPromptInjection: readRecordValue(hooksRaw, "allowPromptInjection"),
          allowConversationAccess: readRecordValue(hooksRaw, "allowConversationAccess"),
          timeoutMs: normalizeHookTimeoutMs(readRecordValue(hooksRaw, "timeoutMs")),
          timeouts: normalizeHookTimeouts(readRecordValue(hooksRaw, "timeouts")),
        }
      : undefined;
    const normalizedHooks =
      hooks &&
      (typeof hooks.allowPromptInjection === "boolean" ||
        typeof hooks.allowConversationAccess === "boolean" ||
        hooks.timeoutMs !== undefined ||
        hooks.timeouts !== undefined)
        ? {
            ...(typeof hooks.allowPromptInjection === "boolean"
              ? { allowPromptInjection: hooks.allowPromptInjection }
              : {}),
            ...(typeof hooks.allowConversationAccess === "boolean"
              ? { allowConversationAccess: hooks.allowConversationAccess }
              : {}),
            ...(hooks.timeoutMs !== undefined ? { timeoutMs: hooks.timeoutMs } : {}),
            ...(hooks.timeouts !== undefined ? { timeouts: hooks.timeouts } : {}),
          }
        : undefined;
    const subagentRaw = readRecordValue(value, "subagent");
    const subagentAllowedModels = isRecord(subagentRaw)
      ? readRecordValue(subagentRaw, "allowedModels")
      : undefined;
    const subagent = isRecord(subagentRaw)
      ? {
          allowModelOverride: readRecordValue(subagentRaw, "allowModelOverride"),
          hasAllowedModelsConfig: Array.isArray(subagentAllowedModels),
          allowedModels: normalizeArrayBackedTrimmedStringList(subagentAllowedModels),
        }
      : undefined;
    const normalizedSubagent =
      subagent &&
      (typeof subagent.allowModelOverride === "boolean" ||
        subagent.hasAllowedModelsConfig ||
        (Array.isArray(subagent.allowedModels) && subagent.allowedModels.length > 0))
        ? {
            ...(typeof subagent.allowModelOverride === "boolean"
              ? { allowModelOverride: subagent.allowModelOverride }
              : {}),
            ...(subagent.hasAllowedModelsConfig ? { hasAllowedModelsConfig: true } : {}),
            ...(Array.isArray(subagent.allowedModels) && subagent.allowedModels.length > 0
              ? { allowedModels: subagent.allowedModels }
              : {}),
          }
        : undefined;
    const llmRaw = readRecordValue(value, "llm");
    const llmAllowedModels = isRecord(llmRaw)
      ? readRecordValue(llmRaw, "allowedModels")
      : undefined;
    const llm = isRecord(llmRaw)
      ? {
          allowModelOverride: readRecordValue(llmRaw, "allowModelOverride"),
          hasAllowedModelsConfig: Array.isArray(llmAllowedModels),
          allowedModels: normalizeArrayBackedTrimmedStringList(llmAllowedModels),
          allowAgentIdOverride: readRecordValue(llmRaw, "allowAgentIdOverride"),
        }
      : undefined;
    const normalizedLlm =
      llm &&
      (typeof llm.allowModelOverride === "boolean" ||
        llm.hasAllowedModelsConfig ||
        (Array.isArray(llm.allowedModels) && llm.allowedModels.length > 0) ||
        typeof llm.allowAgentIdOverride === "boolean")
        ? {
            ...(typeof llm.allowModelOverride === "boolean"
              ? { allowModelOverride: llm.allowModelOverride }
              : {}),
            ...(llm.hasAllowedModelsConfig ? { hasAllowedModelsConfig: true } : {}),
            ...(Array.isArray(llm.allowedModels) && llm.allowedModels.length > 0
              ? { allowedModels: llm.allowedModels }
              : {}),
            ...(typeof llm.allowAgentIdOverride === "boolean"
              ? { allowAgentIdOverride: llm.allowAgentIdOverride }
              : {}),
          }
        : undefined;
    const enabled = readRecordValue(value, "enabled");
    normalized[normalizedKey] = {
      ...normalized[normalizedKey],
      enabled: typeof enabled === "boolean" ? enabled : normalized[normalizedKey]?.enabled,
      hooks: normalizedHooks ?? normalized[normalizedKey]?.hooks,
      subagent: normalizedSubagent ?? normalized[normalizedKey]?.subagent,
      llm: normalizedLlm ?? normalized[normalizedKey]?.llm,
      config: hasRecordKey(value, "config")
        ? readRecordValue(value, "config")
        : normalized[normalizedKey]?.config,
    };
  }
  return normalized;
}

export function normalizePluginsConfigWithResolver(
  config?: OpenClawConfig["plugins"],
  normalizePluginId: NormalizePluginId = identityNormalizePluginId,
): NormalizedPluginsConfig {
  const slots = readRecordValue(config, "slots");
  const load = readRecordValue(config, "load");
  const memorySlot = normalizeSlotValue(readRecordValue(slots, "memory"));
  return {
    enabled: readRecordValue(config, "enabled") !== false,
    allow: normalizeList(readRecordValue(config, "allow"), normalizePluginId),
    deny: normalizeList(readRecordValue(config, "deny"), normalizePluginId),
    loadPaths: normalizeList(readRecordValue(load, "paths"), identityNormalizePluginId),
    slots: {
      memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
      contextEngine: normalizeSlotValue(readRecordValue(slots, "contextEngine")),
    },
    entries: normalizePluginEntries(readRecordValue(config, "entries"), normalizePluginId),
  };
}

export function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean {
  if (!plugins) {
    return false;
  }
  if (typeof readRecordValue(plugins, "enabled") === "boolean") {
    return true;
  }
  if ((copyArrayEntries(readRecordValue(plugins, "allow"))?.length ?? 0) > 0) {
    return true;
  }
  if ((copyArrayEntries(readRecordValue(plugins, "deny"))?.length ?? 0) > 0) {
    return true;
  }
  if (
    (copyArrayEntries(readRecordValue(readRecordValue(plugins, "load"), "paths"))?.length ?? 0) > 0
  ) {
    return true;
  }
  if (copyRecordEntries(readRecordValue(plugins, "slots")).length > 0) {
    return true;
  }
  if (copyRecordEntries(readRecordValue(plugins, "entries")).length > 0) {
    return true;
  }
  return false;
}

export function isBundledChannelEnabledByChannelConfig(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
): boolean {
  if (!cfg) {
    return false;
  }
  const channelId = normalizeChatChannelId(pluginId);
  if (!channelId) {
    return false;
  }
  const entry = readRecordValue(readRecordValue(cfg, "channels"), channelId);
  if (!isRecord(entry)) {
    return false;
  }
  return readRecordValue(entry, "enabled") === true;
}
