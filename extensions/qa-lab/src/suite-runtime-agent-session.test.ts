import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionEntries,
  readSkillStatus,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup } = createTempDirHarness();

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

describe("qa suite runtime agent session helpers", () => {
  const gatewayCall = vi.fn();
  const env = {
    gateway: { call: gatewayCall },
    primaryModel: "openai/gpt-5.5",
    alternateModel: "openai/gpt-5.5-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(() => {
    gatewayCall.mockReset();
  });

  it("creates sessions and trims the returned key", async () => {
    gatewayCall.mockResolvedValueOnce({ key: "  session-1  " });

    await expect(createSession(env, "Test Session")).resolves.toBe("session-1");
    const [method, params, options] = gatewayCall.mock.calls[0] ?? [];
    expect(method).toBe("sessions.create");
    expect(params).toEqual({ label: "Test Session" });
    expect(options?.timeoutMs).toBe(60_000);
  });

  it("retries transient session store lock timeouts while creating sessions", async () => {
    const lockTimeoutError = Object.assign(
      new Error("SessionWriteLockTimeoutError: session file locked"),
      { code: "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT" },
    );
    gatewayCall
      .mockRejectedValueOnce(lockTimeoutError)
      .mockResolvedValueOnce({ key: " session-2 " });

    vi.useFakeTimers();
    const pending = createSession(env, "Retry Session", "agent:qa:retry");

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("session-2");
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(gatewayCall).toHaveBeenNthCalledWith(
      2,
      "sessions.create",
      { label: "Retry Session", key: "agent:qa:retry" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("reads effective tool ids once and drops blanks", async () => {
    gatewayCall.mockResolvedValueOnce({
      groups: [
        { tools: [{ id: "alpha" }, { id: " beta " }] },
        { tools: [{ id: "alpha" }, { id: "" }, {}] },
      ],
    });

    await expect(readEffectiveTools(env, "session-1")).resolves.toEqual(new Set(["alpha", "beta"]));
  });

  it("reads skill status for the default qa agent", async () => {
    gatewayCall.mockResolvedValueOnce({
      skills: [{ name: "alpha", eligible: true }],
    });

    await expect(readSkillStatus(env)).resolves.toEqual([{ name: "alpha", eligible: true }]);
    const [method, params, options] = gatewayCall.mock.calls[0] ?? [];
    expect(method).toBe("skills.status");
    expect(params).toEqual({ agentId: "qa" });
    expect(options?.timeoutMs).toBe(45_000);
  });

  it("reads the raw qa session entries through the gateway", async () => {
    gatewayCall.mockResolvedValueOnce({
      sessions: [
        {
          key: "session-1",
          sessionId: "session-1",
          status: "running",
          label: "QA",
          updatedAt: 123,
        },
        {
          key: "",
          sessionId: "blank",
        },
      ],
    });

    await expect(readRawQaSessionEntries(env)).resolves.toEqual({
      "session-1": {
        sessionId: "session-1",
        status: "running",
        label: "QA",
        updatedAt: 123,
      },
    });
    expect(gatewayCall).toHaveBeenCalledWith(
      "sessions.list",
      {
        agentId: "qa",
        includeGlobal: true,
        includeUnknown: true,
        limit: 1000,
      },
      { timeoutMs: 45_000 },
    );
  });

  it("returns an empty session entry map when the gateway returns no sessions", async () => {
    gatewayCall.mockResolvedValueOnce({});

    await expect(readRawQaSessionEntries(env)).resolves.toEqual({});
  });
});
