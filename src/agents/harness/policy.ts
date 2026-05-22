import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  AUTO_AGENT_RUNTIME_ID,
  normalizeOptionalLegacyAgentRuntimeId,
  type EmbeddedAgentRuntime,
} from "../embedded-agent-runner/runtime.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import {
  isOpenAICodexProvider,
  openAIProviderUsesCodexRuntimeByDefault,
} from "../openai-codex-routing.js";

export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: "model" | "provider" | "implicit";
};

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const configured = resolveModelRuntimePolicy({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const configuredRuntime = normalizeOptionalLegacyAgentRuntimeId(configured.policy?.id);
  const runtimeSource = configured.source ?? "implicit";
  const runtime =
    configuredRuntime && configuredRuntime !== "default"
      ? configuredRuntime
      : AUTO_AGENT_RUNTIME_ID;
  if (
    openAIProviderUsesCodexRuntimeByDefault({ provider: params.provider, config: params.config })
  ) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  if (isOpenAICodexProvider(params.provider)) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}
