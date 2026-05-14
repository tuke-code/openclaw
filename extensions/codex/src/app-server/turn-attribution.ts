import type { CodexAppServerClient } from "./client.js";

export type CodexAppServerActiveTurnRegistration = object;

const activeCodexAppServerTurnsByClient = new WeakMap<
  CodexAppServerClient,
  Set<CodexAppServerActiveTurnRegistration>
>();

export function registerCodexAppServerActiveTurn(client: CodexAppServerClient): {
  cleanup: () => void;
  registration: CodexAppServerActiveTurnRegistration;
} {
  let activeTurns = activeCodexAppServerTurnsByClient.get(client);
  if (!activeTurns) {
    activeTurns = new Set<CodexAppServerActiveTurnRegistration>();
    activeCodexAppServerTurnsByClient.set(client, activeTurns);
  }
  const registration: CodexAppServerActiveTurnRegistration = {};
  activeTurns.add(registration);
  let cleanedUp = false;
  return {
    cleanup: () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      activeTurns.delete(registration);
      if (activeTurns.size === 0) {
        activeCodexAppServerTurnsByClient.delete(client);
      }
    },
    registration,
  };
}

export function hasCodexAppServerActiveTurns(client: CodexAppServerClient): boolean {
  return (activeCodexAppServerTurnsByClient.get(client)?.size ?? 0) > 0;
}

export function isOnlyCodexAppServerActiveTurn(
  client: CodexAppServerClient,
  activeTurn: CodexAppServerActiveTurnRegistration,
): boolean {
  const activeTurns = activeCodexAppServerTurnsByClient.get(client);
  return activeTurns?.size === 1 && activeTurns.has(activeTurn);
}
