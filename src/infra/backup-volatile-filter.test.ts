import { describe, expect, it } from "vitest";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";

const stateDir = "/opt/openclaw/state";
const plan = { stateDirs: [stateDir] };

describe("isVolatileBackupPath", () => {
  it.each([
    [`${stateDir}/sessions/s-abc/transcript.jsonl`, true],
    [`${stateDir}/sessions/s-abc/run.log`, true],
    [`${stateDir}/agents/main/sessions/transcript.jsonl`, true],
    [`${stateDir}/agents/ops/sessions/run.log`, true],
    [`${stateDir}/cron/runs/2026-01-01/job.log`, true],
    [`${stateDir}/cron/runs/nightly.jsonl`, true],
    [`${stateDir}/logs/gateway.jsonl`, true],
    [`${stateDir}/logs/nested/gateway.log`, true],
    [`${stateDir}/ipc/gateway.sock`, true],
    [`${stateDir}/gateway.pid`, true],
    [`${stateDir}/tmp/pending.tmp`, true],
    [`${stateDir}/delivery-queue/pending.tmp`, true],
    [`${stateDir}/delivery-queue/pending.json`, true],
    [`${stateDir}/session-delivery-queue/pending.tmp`, true],
    [`${stateDir}/session-delivery-queue/pending.json`, true],
    [`${stateDir}/sessions/s-abc/meta.json`, false],
    [`${stateDir}/agents/main/sessions/sessions.json`, false],
    [`${stateDir}/cron/jobs.json`, false],
    [`${stateDir}/cron/runs/2026-01-01/job.json`, false],
    [`${stateDir}/config.json`, false],
    ["/home/user/project/README.md", false],
    ["/home/user/project/pending.tmp", false],
    ["/home/user/notes/daily.log", false],
  ])("classifies %s as volatile=%s", (p, expected) => {
    expect(isVolatileBackupPath(p, plan)).toBe(expected);
  });

  it("returns false when no state dirs are provided", () => {
    expect(
      isVolatileBackupPath(`${stateDir}/sessions/s-abc/transcript.jsonl`, { stateDirs: [] }),
    ).toBe(false);
  });

  it("does not match paths that escape the anchor via `..`", () => {
    expect(isVolatileBackupPath(`${stateDir}/sessions/../config.jsonl`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/cron/runs/../jobs.log`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/logs/../notes.jsonl`, plan)).toBe(false);
  });

  it("normalizes Windows-style separators before anchor checks", () => {
    const winStateDir = "C:\\openclaw\\state";
    const winPlan = { stateDirs: [winStateDir] };
    expect(isVolatileBackupPath(`${winStateDir}\\sessions\\s-abc\\transcript.jsonl`, winPlan)).toBe(
      true,
    );
    expect(isVolatileBackupPath(`${winStateDir}\\agents\\main\\sessions\\s.jsonl`, winPlan)).toBe(
      true,
    );
    expect(isVolatileBackupPath(`${winStateDir}\\cron\\runs\\2026\\job.jsonl`, winPlan)).toBe(true);
    expect(isVolatileBackupPath(`${winStateDir}\\sessions\\..\\config.jsonl`, winPlan)).toBe(false);
  });

  it("matches tar filter paths when node-tar omits the leading slash", () => {
    expect(
      isVolatileBackupPath("opt/openclaw/state/agents/main/sessions/transcript.jsonl", plan),
    ).toBe(true);
  });
});
