import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool, OpenClawPluginApi } from "./types.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  killProcessTree: vi.fn(),
  signalProcessTree: vi.fn(),
  resolveWindowsSpawnProgram: vi.fn(),
  materializeWindowsSpawnProgram: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: mocks.killProcessTree,
  signalProcessTree: mocks.signalProcessTree,
}));

vi.mock("../plugin-sdk/windows-spawn.js", () => ({
  resolveWindowsSpawnProgram: mocks.resolveWindowsSpawnProgram,
  materializeWindowsSpawnProgram: mocks.materializeWindowsSpawnProgram,
}));

import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createJsonRpcManifestPluginDefinition } from "./json-rpc-manifest-runtime.js";

describe("createJsonRpcManifestPluginDefinition process management", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("resolves child commands through the Windows spawn resolver", async () => {
    const program = {
      command: "resolved-node",
      leadingArgv: ["entry.mjs"],
      resolution: "node-entrypoint",
      windowsHide: true,
    };
    mocks.resolveWindowsSpawnProgram.mockReturnValue(program);
    mocks.materializeWindowsSpawnProgram.mockReturnValue({
      command: "resolved-node",
      argv: ["entry.mjs", "--stdio"],
      shell: false,
      windowsHide: true,
    });
    mocks.spawn.mockReturnValue(asSpawnedChild(new FakeJsonRpcChild()));

    const tools: AnyAgentTool[] = [];
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      id: "json-rpc-process-test",
      name: "JSON RPC Process Test",
      description: "Test spawn resolution",
      process: {
        command: "json-rpc-child",
        args: ["--stdio"],
        env: { JSON_RPC_PROCESS_TEST: "1" },
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process",
          description: "Process",
        },
      ],
    });

    entry.register?.(api);
    await tools[0]?.execute("tool-call-1", {});

    expect(mocks.resolveWindowsSpawnProgram).toHaveBeenCalledWith({
      command: "json-rpc-child",
      platform: process.platform,
      env: expect.objectContaining({ JSON_RPC_PROCESS_TEST: "1" }),
      execPath: process.execPath,
      allowShellFallback: false,
    });
    expect(mocks.materializeWindowsSpawnProgram).toHaveBeenCalledWith(program, ["--stdio"]);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "resolved-node",
      ["entry.mjs", "--stdio"],
      expect.objectContaining({
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  });

  it("does not start a child process for a pre-aborted request", async () => {
    const tools: AnyAgentTool[] = [];
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      id: "json-rpc-process-abort-test",
      name: "JSON RPC Process Abort Test",
      description: "Test pre-aborted process requests",
      process: {
        command: "json-rpc-child",
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process_abort",
          description: "Process abort",
        },
      ],
    });
    const controller = new AbortController();
    controller.abort();

    entry.register?.(api);
    await expect(tools[0]?.execute("tool-call-abort", {}, controller.signal)).rejects.toThrow(
      "JSON-RPC plugin request aborted",
    );

    expect(mocks.resolveWindowsSpawnProgram).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("honors aborts while initialization is pending without canceling shared initialization", async () => {
    mocks.resolveWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: true,
    });
    mocks.materializeWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      argv: [],
      shell: false,
      windowsHide: true,
    });
    const child = new FakeJsonRpcChild({ deferInitialize: true });
    mocks.spawn.mockReturnValue(asSpawnedChild(child));

    const tools: AnyAgentTool[] = [];
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      id: "json-rpc-process-init-abort-test",
      name: "JSON RPC Process Init Abort Test",
      description: "Test initialization abort",
      process: {
        command: "json-rpc-child",
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process_init_abort",
          description: "Process init abort",
        },
      ],
    });
    const controller = new AbortController();

    entry.register?.(api);
    const aborted = tools[0]?.execute("tool-call-abort", {}, controller.signal);
    controller.abort();

    await expect(observeSettled(aborted)).resolves.toBe("JSON-RPC plugin request aborted");

    const active = tools[0]?.execute("tool-call-active", {});
    child.resolveInitialize();
    await expect(active).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("uses process-tree cleanup when stdin shutdown does not stop the child", async () => {
    vi.useFakeTimers();
    mocks.resolveWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: true,
    });
    mocks.materializeWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      argv: [],
      shell: false,
      windowsHide: true,
    });
    mocks.spawn.mockReturnValue(asSpawnedChild(new FakeJsonRpcChild({ closeOnStdinEnd: false })));

    const tools: AnyAgentTool[] = [];
    let cleanup:
      | NonNullable<Parameters<OpenClawPluginApi["registerRuntimeLifecycle"]>[0]["cleanup"]>
      | undefined;
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
      registerRuntimeLifecycle(lifecycle) {
        cleanup = lifecycle.cleanup;
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      id: "json-rpc-process-cleanup-test",
      name: "JSON RPC Process Cleanup Test",
      description: "Test process-tree cleanup",
      process: {
        command: "json-rpc-child",
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process_cleanup",
          description: "Process cleanup",
        },
      ],
    });

    entry.register?.(api);
    await tools[0]?.execute("tool-call-1", {});

    const cleanupPromise = cleanup?.({ reason: "restart" });
    await vi.advanceTimersByTimeAsync(5_000);
    await cleanupPromise;

    expect(mocks.killProcessTree).toHaveBeenCalledWith(4321, { graceMs: 500 });
    expect(mocks.signalProcessTree).toHaveBeenCalledWith(4321, "SIGKILL");
  });
});

function createProcessTestApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "json-rpc-process-test",
    name: "JSON RPC Process Test",
    source: "src/plugins/json-rpc-manifest-runtime.process.test.ts",
    rootDir: process.cwd(),
    ...overrides,
  });
}

class FakeJsonRpcChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  readonly kill = vi.fn();
  readonly stdin: Writable;
  private deferredInitialize: (() => void) | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(options: { closeOnStdinEnd?: boolean; deferInitialize?: boolean } = {}) {
    super();
    const closeOnStdinEnd = options.closeOnStdinEnd ?? true;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.writeResponse(String(chunk), options.deferInitialize === true);
        callback();
      },
      final: (callback) => {
        if (closeOnStdinEnd) {
          this.exitCode = 0;
          this.emit("close", 0, null);
        }
        callback();
      },
    });
  }

  resolveInitialize(): void {
    this.deferredInitialize?.();
    this.deferredInitialize = undefined;
  }

  private writeResponse(chunk: string, deferInitialize: boolean): void {
    for (const line of chunk.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const message = JSON.parse(line) as { id: unknown; method: string };
      if (message.method === "openclaw.initialize" && deferInitialize) {
        this.deferredInitialize = () => this.writeJsonRpcResult(message.id, { ok: true });
        continue;
      }
      const result =
        message.method === "openclaw.tool.execute"
          ? { content: [{ type: "text", text: "ok" }] }
          : { ok: true };
      this.writeJsonRpcResult(message.id, result);
    }
  }

  private writeJsonRpcResult(id: unknown, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}

function asSpawnedChild(child: FakeJsonRpcChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams;
}

function observeSettled(promise: Promise<unknown> | undefined): Promise<string> {
  if (!promise) {
    return Promise.resolve("missing");
  }
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("pending"), 25);
    }),
  ]);
}
