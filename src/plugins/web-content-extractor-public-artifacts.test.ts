import { beforeEach, describe, expect, it, vi } from "vitest";

const { publicArtifactModule } = vi.hoisted(() => ({
  publicArtifactModule: {} as Record<string, unknown>,
}));

vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: vi.fn(() => publicArtifactModule),
}));

import { loadBundledWebContentExtractorEntriesFromDir } from "./web-content-extractor-public-artifacts.js";

describe("loadBundledWebContentExtractorEntriesFromDir", () => {
  beforeEach(() => {
    for (const key of Object.keys(publicArtifactModule)) {
      delete publicArtifactModule[key];
    }
  });

  it("skips unreadable bundled web content extractors while preserving healthy entries", () => {
    const extract = vi.fn();
    publicArtifactModule.createBrokenWebContentExtractor = () => {
      throw new Error("fuzzplugin native probe failed");
    };
    publicArtifactModule.createFuzzWebContentExtractor = () =>
      Object.create(null, {
        id: {
          enumerable: true,
          get() {
            throw new Error("fuzzplugin extractor id getter failed");
          },
        },
        label: { enumerable: true, value: "Fuzz Web Content" },
        extract: { enumerable: true, value: vi.fn() },
      });
    publicArtifactModule.createMockWebContentExtractor = () =>
      Object.create(null, {
        id: { enumerable: true, value: "mockplugin" },
        label: { enumerable: true, value: "Mock Web Content" },
        autoDetectOrder: { enumerable: true, value: 3 },
        docsUrl: {
          enumerable: true,
          get() {
            throw new Error("mockplugin docsUrl getter failed");
          },
        },
        extract: { enumerable: true, value: extract },
      });

    expect(
      loadBundledWebContentExtractorEntriesFromDir({
        dirName: "fuzzplugin",
        pluginId: "fuzzplugin",
      }),
    ).toStrictEqual([
      {
        id: "mockplugin",
        label: "Mock Web Content",
        autoDetectOrder: 3,
        extract,
        pluginId: "fuzzplugin",
      },
    ]);
  });

  it("surfaces initialization failure when every matching factory throws", () => {
    const cause = new Error("fuzzplugin native probe failed");
    publicArtifactModule.createMockWebContentExtractor = () => {
      throw cause;
    };

    expect(() =>
      loadBundledWebContentExtractorEntriesFromDir({
        dirName: "fuzzplugin",
        pluginId: "fuzzplugin",
      }),
    ).toThrow("Unable to initialize web content extractors for plugin fuzzplugin");
  });
});
