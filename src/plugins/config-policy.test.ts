import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  hasExplicitPluginConfig,
  isBundledChannelEnabledByChannelConfig,
  normalizePluginsConfigWithResolver,
} from "./config-policy.js";

describe("normalizePluginsConfigWithResolver", () => {
  it("uses the provided plugin id resolver for allow deny and entry keys", () => {
    const normalized = normalizePluginsConfigWithResolver(
      {
        allow: [" alpha "],
        deny: [" beta "],
        entries: {
          " gamma ": {
            enabled: true,
          },
        },
      },
      (id) => id.trim().toUpperCase(),
    );

    expect(normalized.allow).toEqual(["ALPHA"]);
    expect(normalized.deny).toEqual(["BETA"]);
    expect(normalized.entries).toHaveProperty("GAMMA");
  });

  it("normalizes plugin lists without using hostile array methods", () => {
    const allow = Object.assign(["fuzzplugin"], {
      map() {
        throw new Error("fuzzplugin allow map failed");
      },
      [Symbol.iterator]() {
        throw new Error("fuzzplugin allow iterator failed");
      },
    });
    const allowedModels = Object.assign(["mock/model"], {
      flatMap() {
        throw new Error("mockplugin allowed models flatMap failed");
      },
    });

    const normalized = normalizePluginsConfigWithResolver({
      allow,
      entries: {
        fuzzplugin: {
          llm: { allowedModels },
        },
      },
    } as OpenClawConfig["plugins"]);

    expect(normalized.allow).toEqual(["fuzzplugin"]);
    expect(normalized.entries.fuzzplugin?.llm?.allowedModels).toEqual(["mock/model"]);
  });

  it("skips unreadable plugin config entries while preserving readable siblings", () => {
    const entries = {
      get fuzzplugin() {
        throw new Error("fuzzplugin entry read failed");
      },
      mockplugin: {
        enabled: true,
        hooks: {
          allowPromptInjection: true,
          get timeouts() {
            throw new Error("mockplugin hook timeouts read failed");
          },
        },
      },
    };

    const normalized = normalizePluginsConfigWithResolver({
      entries,
    } as OpenClawConfig["plugins"]);

    expect(normalized.entries).not.toHaveProperty("fuzzplugin");
    expect(normalized.entries.mockplugin).toEqual({
      enabled: true,
      hooks: {
        allowPromptInjection: true,
      },
    });
  });
});

describe("hasExplicitPluginConfig", () => {
  it("detects explicit config from slots and entry keys", () => {
    expect(hasExplicitPluginConfig({ slots: { memory: "none" } })).toBe(true);
    expect(hasExplicitPluginConfig({ entries: { foo: {} } })).toBe(true);
    expect(hasExplicitPluginConfig({})).toBe(false);
  });

  it("treats unreadable plugin config as absent instead of throwing", () => {
    const plugins = {
      get allow() {
        throw new Error("fuzzplugin allow read failed");
      },
      slots: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("mockplugin slots keys failed");
          },
        },
      ),
    };

    expect(hasExplicitPluginConfig(plugins as OpenClawConfig["plugins"])).toBe(false);
  });
});

describe("isBundledChannelEnabledByChannelConfig", () => {
  it("only treats enabled channel entries as bundled plugin enablement", () => {
    const cfg = {
      channels: {
        telegram: { enabled: true },
        slack: { enabled: false },
      },
    } as OpenClawConfig;

    expect(isBundledChannelEnabledByChannelConfig(cfg, "telegram")).toBe(true);
    expect(isBundledChannelEnabledByChannelConfig(cfg, "slack")).toBe(false);
    expect(isBundledChannelEnabledByChannelConfig(cfg, "not-a-channel")).toBe(false);
  });

  it("ignores unreadable channel entries while checking bundled plugin enablement", () => {
    const cfg = {
      channels: {
        get telegram() {
          throw new Error("fuzzplugin channel read failed");
        },
      },
    } as OpenClawConfig;

    expect(isBundledChannelEnabledByChannelConfig(cfg, "telegram")).toBe(false);
  });
});
