import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  resolveAgentMainSessionKey,
  updateSessionStoreEntry,
  type SessionEntry,
} from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { DEFAULT_AGENT_ID, parseAgentSessionKey } from "../routing/session-key.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  if (phase === "error") {
    return "failed";
  }

  const stopReason = typeof event.data?.stopReason === "string" ? event.data.stopReason : "";
  if (stopReason === "aborted") {
    return "killed";
  }

  return event.data?.aborted === true ? "timeout" : "done";
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveTerminalStatus(params.event) === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

function resolveLegacyMainLifecycleStoreKey(params: {
  canonicalKey: string;
  cfg: ReturnType<typeof loadSessionEntry>["cfg"];
  store: ReturnType<typeof loadSessionEntry>["store"];
}): string | undefined {
  const parsed = parseAgentSessionKey(params.canonicalKey);
  if (!parsed) {
    return undefined;
  }
  const mainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: parsed.agentId });
  if (params.canonicalKey !== mainKey) {
    return undefined;
  }
  const candidates = new Set([
    `agent:${parsed.agentId}:main`,
    `agent:${parsed.agentId}:${parsed.rest}`,
  ]);
  if (parsed.agentId === resolveDefaultAgentId(params.cfg)) {
    candidates.add("main");
    candidates.add(parsed.rest);
  }
  if (
    parsed.agentId === resolveDefaultAgentId(params.cfg) &&
    !listAgentIds(params.cfg).includes(DEFAULT_AGENT_ID)
  ) {
    candidates.add(`agent:${DEFAULT_AGENT_ID}:main`);
    candidates.add(`agent:${DEFAULT_AGENT_ID}:${parsed.rest}`);
  }
  let freshest: { key: string; updatedAt: number } | undefined;
  const consider = (key: string) => {
    const entry = params.store[key];
    if (!entry) {
      return;
    }
    const updatedAt = entry.updatedAt ?? 0;
    if (!freshest || updatedAt > freshest.updatedAt) {
      freshest = { key, updatedAt };
    }
  };

  for (const candidate of candidates) {
    consider(candidate);
    const folded = candidate.toLowerCase();
    for (const key of Object.keys(params.store)) {
      if (key.toLowerCase() === folded) {
        consider(key);
      }
    }
  }
  return freshest?.key;
}

export function resolveGatewaySessionLifecycleStoreTarget(params: {
  sessionKey: string;
}): { storePath: string; sessionKey: string } | undefined {
  const sessionEntry = loadSessionEntry(params.sessionKey);
  const sessionKey = sessionEntry.entry
    ? (sessionEntry.legacyKey ?? sessionEntry.canonicalKey)
    : resolveLegacyMainLifecycleStoreKey({
        canonicalKey: sessionEntry.canonicalKey,
        cfg: sessionEntry.cfg,
        store: sessionEntry.store,
      });
  if (!sessionKey) {
    return undefined;
  }
  return { storePath: sessionEntry.storePath, sessionKey };
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  event: LifecycleEventLike;
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const target = resolveGatewaySessionLifecycleStoreTarget({ sessionKey: params.sessionKey });
  if (!target) {
    return;
  }

  await updateSessionStoreEntry({
    storePath: target.storePath,
    sessionKey: target.sessionKey,
    update: async (entry) =>
      derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      }),
  });
}
