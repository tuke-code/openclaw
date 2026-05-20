import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CORE_HEALTH_CHECKS,
  registerCoreHealthChecks,
  resetCoreHealthChecksForTest,
} from "./doctor-core-checks.js";
import { doctorHealthConversionRules } from "./doctor-health-conversion-plan.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
  registerHealthCheck,
} from "./health-check-registry.js";

const detectShellCompletionHealth = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../commands/doctor-completion.js", () => ({
  detectShellCompletionHealth,
}));

describe("registerCoreHealthChecks", () => {
  let tmp: string | undefined;

  beforeEach(() => {
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
  });

  afterEach(async () => {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("registers the built-in health checks once", () => {
    registerCoreHealthChecks();
    registerCoreHealthChecks();

    expect(listHealthChecks().map((check) => check.id)).toEqual(
      CORE_HEALTH_CHECKS.map((check) => check.id),
    );
  });

  it("can retry after a duplicate registration failure is cleared", () => {
    registerHealthCheck({
      id: "core/doctor/gateway-config",
      kind: "core",
      description: "duplicate",
      async detect() {
        return [];
      },
    });

    expect(() => registerCoreHealthChecks()).toThrow("health check already registered");

    clearHealthChecksForTest();
    registerCoreHealthChecks();

    expect(listHealthChecks()).toHaveLength(CORE_HEALTH_CHECKS.length);
  });

  it("registers only implemented core health targets from the doctor conversion inventory", () => {
    registerCoreHealthChecks();

    const registeredIds = new Set(listHealthChecks().map((check) => check.id));
    const coreTargets = new Set<string>(
      doctorHealthConversionRules.flatMap((rule) =>
        rule.target.filter((target) => target.startsWith("core/doctor/")),
      ),
    );
    const plannedOnlyTargets = [
      "core/doctor/auth-profiles/keychain",
      "core/doctor/session-locks",
      "core/doctor/gateway-daemon",
    ];

    for (const id of CORE_HEALTH_CHECKS.map((check) => check.id)) {
      if (id === "core/doctor/browser-clawd-profile-residue") {
        continue;
      }
      expect(coreTargets.has(id)).toBe(true);
    }
    for (const id of plannedOnlyTargets) {
      expect(registeredIds.has(id)).toBe(false);
    }
    expect(
      CORE_HEALTH_CHECKS.some((check) =>
        check.description.endsWith("represented in the health registry."),
      ),
    ).toBe(false);
  });

  it("shows the repair-capable health check shape with skills readiness", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-skills-"));
    const skillDir = join(tmp, "skills", "missing-tool");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: missing-tool
description: Missing tool
metadata: '{"openclaw":{"requires":{"bins":["openclaw-test-missing-skill-bin"]}}}'
---

# Missing tool
`,
      "utf-8",
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmp,
          skills: ["missing-tool"],
        },
      },
    };
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/skills-readiness");

    expect(check?.repair).toBeTypeOf("function");

    const findings = await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg,
      cwd: tmp,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/skills-readiness",
        severity: "warning",
        path: "skills.entries.missing-tool.enabled",
      }),
    );
    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime: { log() {}, error() {}, exit() {} },
          cfg,
          cwd: tmp,
        },
        { paths: ["skills.entries.other-tool.enabled"] },
      ),
    ).resolves.toEqual([]);
    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime: { log() {}, error() {}, exit() {} },
          cfg,
          cwd: tmp,
        },
        { paths: ["skills.entries.missing-tool.enabled"] },
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        path: "skills.entries.missing-tool.enabled",
      }),
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg,
        cwd: tmp,
      },
      findings ?? [],
    );
    expect(repaired?.config?.skills?.entries?.["missing-tool"]).toEqual({ enabled: false });
    expect(repaired?.changes).toContain("Disabled unavailable skill missing-tool.");
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "config",
        action: "disable-skill",
        target: "skills.entries.missing-tool.enabled",
      }),
    );
  });

  it("converts security doctor warnings into health findings", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/security");

    const findings = await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {
        gateway: {
          bind: "lan",
          auth: {
            mode: "none",
          },
        },
      },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "error",
        message: expect.stringContaining("Gateway bound"),
      }),
    );
  });

  it("emits workspace suggestions as doctor notes, not lint findings", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-workspace-"));
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/workspace-suggestions",
    );
    const note = vi.fn();

    const findings = await check?.detect({
      mode: "doctor",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {
        agents: {
          defaults: {
            workspace: tmp,
          },
        },
      },
      cwd: tmp,
      doctor: { note },
    });

    expect(findings).toEqual([]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Tip: back up the workspace in a private git repo"),
      "Workspace",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Memory system not found in workspace."),
      "Workspace",
    );
  });

  it("suppresses workspace suggestion notes when no doctor note sink is provided", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-workspace-"));
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/workspace-suggestions",
    );

    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {
          agents: {
            defaults: {
              workspace: tmp,
            },
          },
        },
        cwd: tmp,
      }),
    ).resolves.toEqual([]);
  });

  it("keeps optional shell completion installs out of doctor lint", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/shell-completion");

    await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {},
    });

    expect(detectShellCompletionHealth).toHaveBeenCalledWith({ nonInteractive: true });
  });

  it("previews converted side-effect repairs as effects without fake diffs", async () => {
    const runtime = { log() {}, error() {}, exit() {} };
    const cases = [
      {
        id: "core/doctor/shell-completion",
        expectedAction: "would-repair-shell-completion",
      },
      {
        id: "core/doctor/startup-channel-maintenance",
        expectedAction: "would-run-channel-startup-maintenance",
      },
      {
        id: "core/doctor/systemd-linger",
        expectedAction: "would-enable-systemd-linger",
      },
    ];

    for (const entry of cases) {
      const check = CORE_HEALTH_CHECKS.find((candidate) => candidate.id === entry.id);
      const result = await check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg: {},
          dryRun: true,
          diff: true,
        },
        [
          {
            checkId: entry.id,
            severity: "warning",
            message: "needs repair",
          },
        ],
      );

      expect(result?.changes).toHaveLength(1);
      expect(result?.effects).toContainEqual(
        expect.objectContaining({
          action: entry.expectedAction,
          dryRunSafe: false,
        }),
      );
      expect(result?.diffs ?? []).toEqual([]);
    }
  });
});
