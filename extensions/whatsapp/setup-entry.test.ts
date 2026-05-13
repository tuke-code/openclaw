import { describe, expect, it, vi } from "vitest";
import * as doctorLegacyStateApi from "./doctor-legacy-state-api.js";
import * as doctorSessionMigrationSurfaceApi from "./doctor-session-migration-surface-api.js";
import setupEntry from "./setup-entry.js";
import * as setupPluginApi from "./setup-plugin-api.js";

vi.mock("baileys", () => {
  throw new Error("setup plugin load must not load Baileys");
});

vi.mock("./src/setup-finalize.js", () => {
  throw new Error("setup status load must not load finalize");
});

const setupEntryLoadOptions = {
  createLoaderForTest: (() => (specifier: string) => {
    if (/[\\/]setup-plugin-api\.[jt]s$/u.test(specifier)) {
      return setupPluginApi;
    }
    if (/[\\/]doctor-legacy-state-api\.[jt]s$/u.test(specifier)) {
      return doctorLegacyStateApi;
    }
    if (/[\\/]doctor-session-migration-surface-api\.[jt]s$/u.test(specifier)) {
      return doctorSessionMigrationSurfaceApi;
    }
    throw new Error(`unexpected setup entry module load: ${specifier}`);
  }) as never,
};

describe("whatsapp setup entry", () => {
  it("loads setup entry metadata without importing runtime dependencies", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({
      doctorSessionMigrationSurface: true,
      doctorLegacyState: true,
    });
  });

  it("loads the setup plugin without installing runtime dependencies", () => {
    const whatsappSetupPlugin = setupEntry.loadSetupPlugin(setupEntryLoadOptions);
    expect(whatsappSetupPlugin.id).toBe("whatsapp");
  });

  it("loads legacy setup helpers without importing runtime dependencies", () => {
    const detectDoctorLegacyState =
      setupEntry.loadDoctorLegacyStateDetector?.(setupEntryLoadOptions);
    if (!detectDoctorLegacyState) {
      throw new Error("expected WhatsApp legacy state migration detector");
    }
    expect(
      detectDoctorLegacyState({
        cfg: {},
        env: {},
        oauthDir: "/tmp/openclaw-whatsapp-empty",
        stateDir: "/tmp/openclaw-state",
      }),
    ).toStrictEqual([]);
    expect(setupEntry.loadDoctorSessionMigrationSurface?.(setupEntryLoadOptions)).toEqual({
      canonicalizeLegacySessionKey: expect.any(Function),
      isLegacyGroupSessionKey: expect.any(Function),
    });
  });

  it("loads the delegated setup wizard without importing runtime dependencies", async () => {
    const { whatsappSetupWizard } = await import("./src/setup-surface.js");

    expect(whatsappSetupWizard.channel).toBe("whatsapp");
  });
});
