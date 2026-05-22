import type { Api, Model } from "openclaw/plugin-sdk/llm";

type AgentModelWithOptionalContextTokens = Model<Api> & {
  contextTokens?: number;
};

export function readAgentModelContextTokens(
  model: Model<Api> | null | undefined,
): number | undefined {
  const value = (model as AgentModelWithOptionalContextTokens | null | undefined)?.contextTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
