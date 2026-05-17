import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionTranscriptScope(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
}): Promise<{ agentId: string; sessionId: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey } = params;
  const now = Date.now();
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Session stores are SQLite-only; cannot resolve agent for ${sessionKey}`);
  }
  const existingEntry = params.sessionEntry ?? getSessionEntry({ agentId, sessionKey });
  const baseEntry = existingEntry ?? {
    sessionId,
    updatedAt: now,
    sessionStartedAt: now,
  };
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: now,
    sessionStartedAt: baseEntry.sessionId === sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
  };
  if (!existingEntry || baseEntry.sessionId !== sessionId) {
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: persistedEntry,
    });
    return { agentId, sessionId, sessionEntry: persistedEntry };
  }
  return { agentId, sessionId, sessionEntry: persistedEntry };
}
