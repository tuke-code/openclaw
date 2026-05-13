import type { AgentTool } from "../agent-core-contract.js";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
import type { HookContext } from "../pi-tools.before-tool-call.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  toolHookContext?: HookContext;
}): {
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools, toolHookContext } = options;
  return {
    customTools: toToolDefinitions(tools, toolHookContext),
  };
}
