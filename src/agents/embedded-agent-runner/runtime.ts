export type EmbeddedAgentRuntime = "openclaw" | "auto" | (string & {});

export const OPENCLAW_AGENT_RUNTIME_ID = "openclaw";
export const AUTO_AGENT_RUNTIME_ID = "auto";
const DEPRECATED_PI_AGENT_RUNTIME_ID = "pi";

export function normalizeEmbeddedAgentRuntime(raw: string | undefined): EmbeddedAgentRuntime {
  const value = raw?.trim();
  if (!value) {
    return OPENCLAW_AGENT_RUNTIME_ID;
  }
  if (value === "openclaw") {
    return OPENCLAW_AGENT_RUNTIME_ID;
  }
  if (value === "auto") {
    return AUTO_AGENT_RUNTIME_ID;
  }
  if (value === "codex-app-server") {
    return "codex";
  }
  return value;
}

export function normalizeOptionalAgentRuntimeId(raw: unknown): EmbeddedAgentRuntime | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  return value ? normalizeEmbeddedAgentRuntime(value) : undefined;
}

/** @deprecated Compatibility for shipped config/session/env values that used the old Pi runtime id. */
export function normalizeLegacyAgentRuntimeId(raw: string | undefined): EmbeddedAgentRuntime {
  const runtime = normalizeEmbeddedAgentRuntime(raw);
  return runtime === DEPRECATED_PI_AGENT_RUNTIME_ID ? OPENCLAW_AGENT_RUNTIME_ID : runtime;
}

/** @deprecated Compatibility for shipped config/session/env values that used the old Pi runtime id. */
export function normalizeOptionalLegacyAgentRuntimeId(
  raw: unknown,
): EmbeddedAgentRuntime | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  return value ? normalizeLegacyAgentRuntimeId(value) : undefined;
}

export function isDefaultAgentRuntimeId(runtime: string | undefined): boolean {
  return runtime === undefined || runtime === AUTO_AGENT_RUNTIME_ID || runtime === "default";
}

export function resolveEmbeddedAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddedAgentRuntime {
  return (
    normalizeOptionalLegacyAgentRuntimeId(env.OPENCLAW_AGENT_RUNTIME) ?? OPENCLAW_AGENT_RUNTIME_ID
  );
}
