import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot, resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
  persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";

describe("session lifecycle state", () => {
  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 500,
          status: "done",
          startedAt: 100,
          endedAt: 400,
          runtimeMs: 300,
          abortedLastRun: true,
        },
        event: {
          ts: 1_000,
          data: {
            phase: "start",
            startedAt: 900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 900,
      status: "running",
      startedAt: 900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_200,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            startedAt: 1_200,
            endedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "done",
      startedAt: 1_200,
      endedAt: 1_900,
      runtimeMs: 700,
      abortedLastRun: false,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_800,
            stopReason: "aborted",
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_800,
      status: "killed",
      startedAt: 1_100,
      endedAt: 1_800,
      runtimeMs: 700,
      abortedLastRun: true,
    });
  });

  it("maps aborted lifecycle end events without stopReason to timeout", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_550,
            aborted: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });

  it.each([
    {
      name: "bare main",
      requestKey: "main",
      storeKey: "main",
      cfg: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
      },
    },
    {
      name: "canonical main",
      requestKey: "agent:main:main",
      storeKey: "main",
      cfg: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
      },
    },
    {
      name: "legacy default-agent alias",
      requestKey: "agent:ops:work",
      storeKey: "agent:main:main",
      cfg: {
        session: { mainKey: "work" },
        agents: { list: [{ id: "ops", default: true }] },
      },
    },
    {
      name: "bare custom mainKey",
      requestKey: "agent:ops:work",
      storeKey: "work",
      cfg: {
        session: { mainKey: "work" },
        agents: { list: [{ id: "ops", default: true }] },
      },
    },
  ])("persists lifecycle patches to the matched legacy store key for $name", async (scenario) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-legacy-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [scenario.storeKey]: {
              sessionId: "sess-main",
              updatedAt: 1_000,
              status: "running",
              startedAt: 900,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const cfg = {
        ...scenario.cfg,
        session: { ...scenario.cfg.session, store: storePath },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      await persistGatewaySessionLifecycleEvent({
        sessionKey: scenario.requestKey,
        event: {
          ts: 2_000,
          data: {
            phase: "error",
            startedAt: 900,
            endedAt: 1_900,
          },
        },
      });

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(store[scenario.storeKey]).toMatchObject({
        sessionId: "sess-main",
        status: "failed",
        startedAt: 900,
        endedAt: 1_900,
        runtimeMs: 1_000,
      });
      expect(typeof store[scenario.storeKey]?.updatedAt).toBe("number");
    } finally {
      resetConfigRuntimeState();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reuse bare main for non-default agents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-non-default-main-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sess-default-main",
              updatedAt: 2_000,
              status: "running",
              startedAt: 1_800,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      await persistGatewaySessionLifecycleEvent({
        sessionKey: "agent:ops:main",
        event: {
          ts: 3_000,
          data: {
            phase: "error",
            startedAt: 1_800,
            endedAt: 2_900,
          },
        },
      });

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(store.main).toMatchObject({
        sessionId: "sess-default-main",
        status: "running",
      });
    } finally {
      resetConfigRuntimeState();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reuse legacy default-agent aliases for non-default agents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-non-default-alias-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            "agent:main:work": {
              sessionId: "sess-default-legacy",
              updatedAt: 2_000,
              status: "running",
              startedAt: 1_800,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const cfg = {
        session: { mainKey: "work", store: storePath },
        agents: { list: [{ id: "ops", default: true }, { id: "qa" }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      await persistGatewaySessionLifecycleEvent({
        sessionKey: "agent:qa:work",
        event: {
          ts: 3_000,
          data: {
            phase: "error",
            startedAt: 1_800,
            endedAt: 2_900,
          },
        },
      });

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(store["agent:main:work"]).toMatchObject({
        sessionId: "sess-default-legacy",
        status: "running",
      });
    } finally {
      resetConfigRuntimeState();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a configured main agent as a legacy alias", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-real-main-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            "agent:main:work": {
              sessionId: "sess-real-main",
              updatedAt: 2_000,
              status: "running",
              startedAt: 1_800,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const cfg = {
        session: { mainKey: "work", store: storePath },
        agents: { list: [{ id: "ops", default: true }, { id: "main" }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      await persistGatewaySessionLifecycleEvent({
        sessionKey: "agent:ops:work",
        event: {
          ts: 3_000,
          data: {
            phase: "error",
            startedAt: 1_800,
            endedAt: 2_900,
          },
        },
      });

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(store["agent:main:work"]).toMatchObject({
        sessionId: "sess-real-main",
        status: "running",
      });
    } finally {
      resetConfigRuntimeState();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists lifecycle patches to the freshest duplicate legacy main alias", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-freshest-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sess-stale",
              updatedAt: 1_000,
              status: "running",
              startedAt: 900,
            },
            "agent:main:work": {
              sessionId: "sess-fresh",
              updatedAt: 2_000,
              status: "running",
              startedAt: 1_800,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const cfg = {
        session: { mainKey: "work", store: storePath },
        agents: { list: [{ id: "ops", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      await persistGatewaySessionLifecycleEvent({
        sessionKey: "agent:ops:work",
        event: {
          ts: 3_000,
          data: {
            phase: "error",
            startedAt: 1_800,
            endedAt: 2_900,
          },
        },
      });

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(store["agent:main:work"]).toMatchObject({
        sessionId: "sess-fresh",
        status: "failed",
        startedAt: 1_800,
        endedAt: 2_900,
        runtimeMs: 1_100,
      });
    } finally {
      resetConfigRuntimeState();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
