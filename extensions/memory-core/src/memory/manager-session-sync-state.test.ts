import { describe, expect, it } from "vitest";
import {
  resolveMemorySessionStartupDirtyFiles,
  resolveMemorySessionSyncPlan,
} from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active source keys and bulk hashes for full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [
        { agentId: "main", sessionId: "a" },
        { agentId: "main", sessionId: "b" },
      ],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(),
      existingRows: [
        { sourceKey: "session:a", path: "transcript:main:a", hash: "hash-a" },
        { sourceKey: "session:b", path: "transcript:main:b", hash: "hash-b" },
      ],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activeSourceKeys).toEqual(new Set(["session:a", "session:b"]));
    expect(plan.existingRows).toEqual([
      { sourceKey: "session:a", path: "transcript:main:a", hash: "hash-a" },
      { sourceKey: "session:b", path: "transcript:main:b", hash: "hash-b" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["session:a", "hash-a"],
        ["session:b", "hash-b"],
      ]),
    );
  });

  it("treats targeted session syncs as refresh-only and skips unrelated pruning", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [{ agentId: "main", sessionId: "targeted-first" }],
      targetSessionTranscriptKeys: new Set(["main\0targeted-first"]),
      dirtySessionTranscripts: new Set(["main\0targeted-first"]),
      existingRows: [
        {
          sourceKey: "session:targeted-first",
          path: "transcript:main:targeted-first",
          hash: "hash-first",
        },
        {
          sourceKey: "session:targeted-second",
          path: "transcript:main:targeted-second",
          hash: "hash-second",
        },
      ],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activeSourceKeys).toBeNull();
    expect(plan.existingRows).toBeNull();
    expect(plan.existingHashes).toBeNull();
  });

  it("keeps dirty-only incremental mode when no targeted sync is requested", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [{ agentId: "main", sessionId: "incremental" }],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(["main\0incremental"]),
      existingRows: [],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activeSourceKeys).toEqual(new Set(["session:incremental"]));
  });

  it("marks missing and changed startup session files dirty", () => {
    const dirtyFiles = resolveMemorySessionStartupDirtyFiles({
      files: [
        {
          absPath: "/tmp/sessions/unchanged.jsonl",
          path: "sessions/unchanged.jsonl",
          mtimeMs: 100,
          size: 10,
        },
        {
          absPath: "/tmp/sessions/newer.jsonl",
          path: "sessions/newer.jsonl",
          mtimeMs: 250,
          size: 20,
        },
        {
          absPath: "/tmp/sessions/resized.jsonl",
          path: "sessions/resized.jsonl",
          mtimeMs: 300,
          size: 31,
        },
        {
          absPath: "/tmp/sessions/missing.jsonl",
          path: "sessions/missing.jsonl",
          mtimeMs: 400,
          size: 40,
        },
      ],
      existingRows: [
        { path: "sessions/unchanged.jsonl", hash: "hash-unchanged", mtime: 100, size: 10 },
        { path: "sessions/newer.jsonl", hash: "hash-newer", mtime: 200, size: 20 },
        { path: "sessions/resized.jsonl", hash: "hash-resized", mtime: 300, size: 30 },
      ],
    });

    expect(dirtyFiles).toEqual([
      "/tmp/sessions/newer.jsonl",
      "/tmp/sessions/resized.jsonl",
      "/tmp/sessions/missing.jsonl",
    ]);
  });
});
