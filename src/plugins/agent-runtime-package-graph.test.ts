import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type PnpmWorkspaceConfig = {
  minimumReleaseAgeExclude?: string[];
  overrides?: Record<string, string>;
};

const MANIFEST_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function isInternalizedRuntimePackage(packageName: string): boolean {
  if (packageName === "@earendil-works/pi-tui") {
    return false;
  }
  return (
    (packageName.startsWith("@earendil-works/") || packageName.startsWith("@mariozechner/")) &&
    /^pi-(?:agent-core|ai|coding-agent)$/u.test(packageName.split("/").at(-1) ?? "")
  );
}

function isRemovedRuntimePackageDir(packageDir: string): boolean {
  return /^packages\/pi-(?:agent-core|ai|coding-agent)$/u.test(packageDir);
}

function collectPackageJsonPaths(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectPackageJsonPaths(entryPath, results);
    } else if (entry.name === "package.json") {
      results.push(entryPath);
    }
  }
  return results;
}

function collectSourceFilePaths(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFilePaths(entryPath, results);
    } else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
      results.push(entryPath);
    }
  }
  return results;
}

function collectWorkspacePackageManifests(): Array<{
  relativePath: string;
  manifest: PackageManifest;
}> {
  const cwd = process.cwd();
  const manifestPaths = new Set<string>([path.join(cwd, "package.json")]);
  for (const root of ["extensions", "packages"] as const) {
    for (const manifestPath of collectPackageJsonPaths(path.resolve(cwd, root))) {
      manifestPaths.add(manifestPath);
    }
  }
  return [...manifestPaths].toSorted().map((manifestPath) => ({
    relativePath: path.relative(cwd, manifestPath),
    manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest,
  }));
}

function readPnpmWorkspaceConfig(): PnpmWorkspaceConfig {
  const workspacePath = path.resolve(process.cwd(), "pnpm-workspace.yaml");
  return YAML.parse(fs.readFileSync(workspacePath, "utf8")) as PnpmWorkspaceConfig;
}

describe("agent runtime package graph guardrails", () => {
  it("keeps the former agent runtime packages internalized into OpenClaw", () => {
    const violations: string[] = [];
    const packagesRoot = path.resolve(process.cwd(), "packages");
    for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      const packageDir = path.posix.join("packages", entry.name);
      if (entry.isDirectory() && isRemovedRuntimePackageDir(packageDir)) {
        violations.push(`${packageDir} still exists`);
      }
    }

    const manifests = collectWorkspacePackageManifests();
    for (const { relativePath, manifest } of manifests) {
      for (const section of MANIFEST_DEPENDENCY_SECTIONS) {
        const dependencies = manifest[section] ?? {};
        for (const packageName of Object.keys(dependencies)) {
          if (isInternalizedRuntimePackage(packageName)) {
            violations.push(`${relativePath} ${section}.${packageName}`);
          }
        }
      }
    }

    const workspaceConfig = readPnpmWorkspaceConfig();
    for (const packageName of workspaceConfig.minimumReleaseAgeExclude ?? []) {
      if (isInternalizedRuntimePackage(packageName)) {
        violations.push(`pnpm-workspace minimumReleaseAgeExclude.${packageName}`);
      }
    }
    for (const packageName of Object.keys(workspaceConfig.overrides ?? {})) {
      if (isInternalizedRuntimePackage(packageName)) {
        violations.push(`pnpm-workspace overrides.${packageName}`);
      }
    }

    expect(violations).toStrictEqual([]);
  });

  it("keeps core production code off public agent runtime SDK facades", () => {
    const cwd = process.cwd();
    const allowed = new Set([
      "src/plugin-sdk/agent-core.ts",
      "src/plugin-sdk/agent-sessions.ts",
      "src/agents/sessions/extensions/loader.ts",
    ]);
    const importPattern =
      /\bfrom\s+["']openclaw\/plugin-sdk\/agent-(?:core|sessions)["']|\bimport\s*\(\s*["']openclaw\/plugin-sdk\/agent-(?:core|sessions)["']\s*\)/u;
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    const violations = collectSourceFilePaths(path.resolve(cwd, "src"))
      .map((filePath) => path.relative(cwd, filePath).replaceAll(path.sep, "/"))
      .filter((relativePath) => !allowed.has(relativePath))
      .filter((relativePath) => !relativePath.endsWith(".d.ts"))
      .filter((relativePath) => !relativePath.includes(".test."))
      .filter((relativePath) => !relativePath.includes("/test-helpers/"))
      .filter((relativePath) =>
        importPattern.test(stripComments(fs.readFileSync(path.resolve(cwd, relativePath), "utf8"))),
      );

    expect(violations).toStrictEqual([]);
  });
});
