import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";

export function normalizeResolvedProviderModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeModelCompat(params.model);
}
