import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("ClawRouter plugin", () => {
  it("registers a credential owner without a synthetic model catalog", () => {
    const captured = capturePluginRegistration(plugin);
    const provider = captured.providers[0];

    expect(captured.modelCatalogProviders).toHaveLength(0);
    expect(provider?.catalog).toBeUndefined();
    expect(provider).toMatchObject({
      id: "clawrouter",
      label: "ClawRouter",
      envVars: ["CLAWROUTER_API_KEY"],
      routeModelTransport: expect.any(Function),
      prepareModelTransportRoute: expect.any(Function),
    });
  });
});
