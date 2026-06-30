// JSON-RPC manifest entries bridge static plugin descriptors to child-process runtimes.
import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { RespondFn } from "../gateway/server-methods/types.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { killProcessTree, signalProcessTree } from "../process/kill-tree.js";
import { isPluginHookName, type PluginHookHandlerMap } from "./hook-types.js";
import type { PluginManifestJsonRpc, PluginManifestJsonRpcRegistration } from "./manifest.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
} from "./types.js";

export type JsonRpcPluginJsonPrimitive = string | number | boolean | null;
export type JsonRpcPluginJsonValue =
  | JsonRpcPluginJsonPrimitive
  | { [key: string]: JsonRpcPluginJsonValue }
  | JsonRpcPluginJsonValue[];
export type JsonRpcPluginJsonObject = { [key: string]: JsonRpcPluginJsonValue };

export type JsonRpcPluginProcessOptions = PluginManifestJsonRpc["process"];

export type JsonRpcPluginRegistration = PluginManifestJsonRpcRegistration;
export type JsonRpcPluginToolRegistration = Extract<JsonRpcPluginRegistration, { type: "tool" }>;
export type JsonRpcPluginHookRegistration = Extract<JsonRpcPluginRegistration, { type: "hook" }>;
export type JsonRpcPluginHttpRouteRegistration = Extract<
  JsonRpcPluginRegistration,
  { type: "httpRoute" }
>;
export type JsonRpcPluginGatewayMethodRegistration = Extract<
  JsonRpcPluginRegistration,
  { type: "gatewayMethod" }
>;

export type JsonRpcManifestPluginOptions = {
  id: string;
  name: string;
  description: string;
  kind?: OpenClawPluginDefinition["kind"];
  configSchema?: OpenClawPluginConfigSchema;
  process: JsonRpcPluginProcessOptions;
  registrations: readonly JsonRpcPluginRegistration[];
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id?: unknown;
  result?: unknown;
  error?: {
    code?: number | string;
    message?: string;
    data?: unknown;
  };
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
const PROCESS_CLOSE_TIMEOUT_MS = 2_000;
const PROCESS_TREE_KILL_GRACE_MS = 500;
const SIGKILL_REAP_TIMEOUT_MS = 500;
const DEFAULT_TOOL_METHOD = "openclaw.tool.execute";
const DEFAULT_HOOK_METHOD = "openclaw.hook.handle";
const DEFAULT_HTTP_METHOD = "openclaw.http.handle";
const DEFAULT_GATEWAY_METHOD = "openclaw.gateway.handle";
const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
} as const satisfies JsonRpcPluginJsonObject;

export function createJsonRpcManifestPluginDefinition(
  options: JsonRpcManifestPluginOptions,
): OpenClawPluginDefinition {
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.configSchema ? { configSchema: options.configSchema } : {}),
    register(api) {
      const client = new JsonRpcPluginClient(api, options.process);
      api.lifecycle.registerRuntimeLifecycle({
        id: `${options.id}.json-rpc-process`,
        description: "JSON-RPC child process owned by this plugin",
        cleanup: async ({ reason }) => {
          if (reason === "disable" || reason === "restart") {
            await client.dispose();
          }
        },
      });

      const gatewayStopHooks = options.registrations.filter(isGatewayStopHookRegistration);
      for (const registration of options.registrations) {
        if (isGatewayStopHookRegistration(registration)) {
          continue;
        }
        registerJsonRpcSurface(api, client, registration);
      }
      registerJsonRpcGatewayStopHook(api, client, gatewayStopHooks);
    },
  };
}

function registerJsonRpcSurface(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginRegistration,
): void {
  if (registration.type === "tool") {
    registerJsonRpcTool(api, client, registration);
    return;
  }
  if (registration.type === "hook") {
    registerJsonRpcHook(api, client, registration);
    return;
  }
  if (registration.type === "httpRoute") {
    registerJsonRpcHttpRoute(api, client, registration);
    return;
  }
  registerJsonRpcGatewayMethod(api, client, registration);
}

function isGatewayStopHookRegistration(
  registration: JsonRpcPluginRegistration,
): registration is JsonRpcPluginHookRegistration {
  return registration.type === "hook" && registration.hook === "gateway_stop";
}

function registerJsonRpcTool(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginToolRegistration,
): void {
  const tool: AnyAgentTool = {
    name: registration.name,
    label: registration.name,
    description: registration.description,
    parameters: registration.parameters ?? EMPTY_OBJECT_SCHEMA,
    ...(registration.displaySummary ? { displaySummary: registration.displaySummary } : {}),
    async execute(toolCallId, params, signal) {
      return (await client.request(
        registration.method ?? DEFAULT_TOOL_METHOD,
        {
          tool: {
            name: registration.name,
          },
          toolCallId,
          params: toJsonRpcValue(params),
        },
        { timeoutMs: registration.timeoutMs, signal },
      )) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
    },
  };
  api.registerTool(tool);
}

function registerJsonRpcHook(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginHookRegistration,
): void {
  if (!isPluginHookName(registration.hook)) {
    throw new Error(`unknown JSON-RPC plugin hook: ${registration.hook}`);
  }
  api.on(
    registration.hook,
    (async (event: unknown, context: unknown) => {
      return await dispatchJsonRpcHook(client, registration, event, context);
    }) as Parameters<OpenClawPluginApi["on"]>[1],
    registration.options,
  );
}

function registerJsonRpcGatewayStopHook(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registrations: readonly JsonRpcPluginHookRegistration[],
): void {
  if (registrations.length === 0) {
    api.on("gateway_stop", () => client.dispose());
    return;
  }
  const handler: PluginHookHandlerMap["gateway_stop"] = async (event, context) => {
    try {
      let result: unknown;
      for (const registration of registrations) {
        result = await dispatchJsonRpcHook(client, registration, event, context);
      }
      return result as void;
    } finally {
      await client.dispose();
    }
  };
  api.on("gateway_stop", handler, registrations[0]?.options);
}

function dispatchJsonRpcHook(
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginHookRegistration,
  event: unknown,
  context: unknown,
): Promise<unknown> {
  return client.request(
    registration.method ?? DEFAULT_HOOK_METHOD,
    {
      hook: {
        name: registration.hook,
      },
      event: toJsonRpcValue(event),
      context: toJsonRpcValue(context),
    },
    { timeoutMs: registration.timeoutMs },
  );
}

function registerJsonRpcHttpRoute(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginHttpRouteRegistration,
): void {
  api.registerHttpRoute({
    path: registration.path,
    auth: registration.auth,
    handler: async (req, res) => {
      const body = await readRequestBody(
        req,
        registration.maxBodyBytes ?? DEFAULT_HTTP_BODY_LIMIT_BYTES,
      );
      const result = await client.request(
        registration.method ?? DEFAULT_HTTP_METHOD,
        {
          route: {
            path: registration.path,
            auth: registration.auth,
          },
          request: {
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: normalizeHeaders(req.headers),
            bodyBase64: body.toString("base64"),
          },
        },
        { timeoutMs: registration.timeoutMs },
      );
      writeJsonRpcHttpResponse(res, result);
      return true;
    },
    ...(registration.match ? { match: registration.match } : {}),
    ...(registration.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: registration.gatewayRuntimeScopeSurface }
      : {}),
    ...(registration.nodeCapability ? { nodeCapability: registration.nodeCapability } : {}),
    ...(registration.replaceExisting !== undefined
      ? { replaceExisting: registration.replaceExisting }
      : {}),
  });
}

function registerJsonRpcGatewayMethod(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginGatewayMethodRegistration,
): void {
  api.registerGatewayMethod(
    registration.method,
    async ({ req, params, client: gatewayClient, respond }) => {
      const result = await client.request(
        registration.rpcMethod ?? DEFAULT_GATEWAY_METHOD,
        {
          method: registration.method,
          request: {
            id: req.id,
            method: req.method,
          },
          params: toJsonRpcValue(params),
          client: gatewayClient
            ? {
                connId: gatewayClient.connId,
                clientIp: gatewayClient.clientIp,
                scopes: gatewayClient.connect?.scopes,
              }
            : null,
        },
        { timeoutMs: registration.timeoutMs },
      );
      respondWithJsonRpcGatewayResult(respond, result);
    },
    registration.scope ? { scope: registration.scope } : undefined,
  );
}

class JsonRpcPluginClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: ReadlineInterface | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initializing: Promise<unknown> | undefined;
  private disposed = false;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly options: JsonRpcPluginProcessOptions,
  ) {}

  async request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    rejectIfAborted(options.signal);
    await waitForAbortable(this.ensureInitialized(), options.signal);
    return this.requestRaw(method, params, options);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  async stop(): Promise<void> {
    this.lines?.close();
    this.lines = undefined;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("JSON-RPC plugin process was disposed"));
    }
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    this.initializing = undefined;
    await stopJsonRpcChild(child);
  }

  private async ensureInitialized(): Promise<void> {
    this.ensureStarted();
    if (!this.initializing) {
      const initialization = this.requestRaw(
        "openclaw.initialize",
        {
          plugin: {
            id: this.api.id,
            name: this.api.name,
            version: this.api.version,
            description: this.api.description,
            source: this.api.source,
            rootDir: this.api.rootDir,
            registrationMode: this.api.registrationMode,
          },
          pluginConfig: toJsonRpcValue(this.api.pluginConfig ?? {}),
        },
        {
          timeoutMs: this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
        },
      ).catch(async (error: unknown) => {
        if (this.initializing === initialization) {
          this.initializing = undefined;
        }
        await this.stop();
        throw error;
      });
      this.initializing = initialization;
    }
    await this.initializing;
  }

  private ensureStarted(): void {
    if (this.disposed) {
      throw new Error("JSON-RPC plugin process was disposed");
    }
    if (this.child) {
      return;
    }
    const env =
      this.options.inheritEnv === false
        ? { ...this.options.env }
        : {
            ...process.env,
            ...this.options.env,
          };
    const spawnInvocation = resolveJsonRpcSpawnInvocation({
      command: resolveJsonRpcProcessCommand(this.api, this.options.command),
      args: [...(this.options.args ?? [])],
      env,
    });
    const cwd = this.options.cwd ? this.api.resolvePath(this.options.cwd) : this.api.rootDir;
    const child = spawn(spawnInvocation.command, spawnInvocation.argv, {
      cwd,
      detached: process.platform !== "win32",
      env,
      shell: spawnInvocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: spawnInvocation.windowsHide,
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => {
      if (this.child === child) {
        this.failAll(error);
      }
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      const label = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.failAll(new Error(`JSON-RPC plugin process closed with ${label}`));
      this.child = undefined;
      this.lines?.close();
      this.lines = undefined;
      this.initializing = undefined;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (this.options.logStderr === false) {
        return;
      }
      const message = String(chunk).trim();
      if (message) {
        this.api.logger.warn(`[${this.api.id}] ${message}`);
      }
    });
  }

  private requestRaw(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    rejectIfAborted(options.signal);
    this.ensureStarted();
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("JSON-RPC plugin process is not running"));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC plugin request timed out: ${method}`));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`JSON-RPC plugin request aborted: ${method}`));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          options.signal?.removeEventListener("abort", abort);
          reject(error);
        },
        timeout,
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      this.api.logger.warn(`Ignoring invalid JSON-RPC response from plugin ${this.api.id}`);
      return;
    }
    if (typeof response.id !== "number") {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message ?? "JSON-RPC plugin request failed"));
      return;
    }
    pending.resolve(response.result);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function resolveJsonRpcSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
} {
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: process.platform,
    env: params.env,
    execPath: process.execPath,
    allowShellFallback: false,
  });
  return materializeWindowsSpawnProgram(program, params.args);
}

function resolveJsonRpcProcessCommand(api: OpenClawPluginApi, command: string): string {
  if (path.isAbsolute(command)) {
    return command;
  }
  if (!command.includes("/") && !command.includes("\\")) {
    return command;
  }
  return api.resolvePath(command);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function hasChildExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function rejectIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("JSON-RPC plugin request aborted");
  }
}

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  rejectIfAborted(signal);
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      cleanup();
      reject(new Error("JSON-RPC plugin request aborted"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function stopJsonRpcChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || hasChildExited(child)) {
    return;
  }
  const closePromise = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  try {
    child.stdin.end();
  } catch {
    // best-effort
  }
  await Promise.race([closePromise, delay(PROCESS_CLOSE_TIMEOUT_MS)]);
  if (hasChildExited(child) || !child.pid) {
    return;
  }
  killProcessTree(child.pid, { graceMs: PROCESS_TREE_KILL_GRACE_MS });
  await Promise.race([closePromise, delay(PROCESS_CLOSE_TIMEOUT_MS)]);
  if (hasChildExited(child) || !child.pid) {
    return;
  }
  signalProcessTree(child.pid, "SIGKILL");
  await Promise.race([closePromise, delay(SIGKILL_REAP_TIMEOUT_MS)]);
}

function toJsonRpcValue(value: unknown): JsonRpcPluginJsonValue {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON-RPC params must be JSON-serialized, not cloned with Date/Map/object prototypes intact.
  return JSON.parse(JSON.stringify(value ?? null)) as JsonRpcPluginJsonValue;
}

function normalizeHeaders(headers: IncomingMessage["headers"]): JsonRpcPluginJsonObject {
  const normalized: JsonRpcPluginJsonObject = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req as Readable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(`JSON-RPC plugin HTTP request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJsonRpcHttpResponse(res: ServerResponse, result: unknown): void {
  if (!isRecord(result)) {
    res.statusCode = 502;
    res.end("JSON-RPC plugin returned an invalid HTTP response");
    return;
  }
  const status = typeof result.status === "number" ? result.status : 200;
  res.statusCode = status;
  if (isRecord(result.headers)) {
    for (const [key, value] of Object.entries(result.headers)) {
      if (typeof value === "string" || Array.isArray(value)) {
        res.setHeader(key, value);
      }
    }
  }
  if (typeof result.bodyBase64 === "string") {
    res.end(Buffer.from(result.bodyBase64, "base64"));
    return;
  }
  res.end(typeof result.bodyText === "string" ? result.bodyText : "");
}

function respondWithJsonRpcGatewayResult(respond: RespondFn, result: unknown): void {
  if (isRecord(result) && typeof result.ok === "boolean") {
    respond(
      result.ok,
      result.payload,
      toGatewayError(result.error),
      isRecord(result.meta) ? result.meta : undefined,
    );
    return;
  }
  respond(true, result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toGatewayError(error: unknown): ErrorShape | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const message = typeof error.message === "string" ? error.message : "Plugin request failed";
  const code = typeof error.code === "string" ? error.code : "plugin_error";
  return {
    code,
    message,
    ...(error.details !== undefined ? { details: toJsonRpcValue(error.details) } : {}),
  };
}
