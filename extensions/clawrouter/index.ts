import { definePluginEntry, type ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { createClawRouterTransportRouter } from "./transport-router.js";

const PROVIDER_ID = "clawrouter";
const ENV_VAR = "CLAWROUTER_API_KEY";

function buildApiKeyAuth(): ProviderAuthMethod {
  return createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: "api-key",
    label: "ClawRouter proxy key",
    hint: "Credential-scoped access to approved provider routes",
    optionKey: "clawrouterApiKey",
    flagName: "--clawrouter-api-key",
    envVar: ENV_VAR,
    promptMessage: "Enter ClawRouter proxy key",
    wizard: {
      choiceId: "clawrouter-api-key",
      choiceLabel: "ClawRouter proxy key",
      choiceHint: "Managed access to approved provider routes",
      groupId: PROVIDER_ID,
      groupLabel: "ClawRouter",
      groupHint: "Managed provider access",
    },
  });
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "ClawRouter",
  description: "Routes canonical provider models through ClawRouter",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ClawRouter",
      envVars: [ENV_VAR],
      auth: [buildApiKeyAuth()],
      ...createClawRouterTransportRouter(),
    });
  },
});
