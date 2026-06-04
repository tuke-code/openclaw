/** Connected node-hosted plugin tools available to agent tool resolution. */
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/index.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";

export type ConnectedNodePluginTool = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  descriptor: NodePluginToolDescriptor;
};

const toolsByNodeId = new Map<string, ConnectedNodePluginTool[]>();
const NODE_PLUGIN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function defaultParameters(): Record<string, unknown> {
  return { type: "object", properties: {}, additionalProperties: true };
}

function isProviderSafeToolName(value: string): boolean {
  return NODE_PLUGIN_TOOL_NAME_RE.test(value);
}

function listRegisteredNodePluginToolDescriptors(): Map<string, NodePluginToolDescriptor> {
  const registry = getActiveRuntimePluginRegistry();
  const descriptors = new Map<string, NodePluginToolDescriptor>();
  for (const entry of registry?.nodeHostCommands ?? []) {
    const agentTool = entry.command.agentTool;
    const name = normalizeString(agentTool?.name);
    const description = normalizeString(agentTool?.description);
    const command = normalizeString(entry.command.command);
    if (!isProviderSafeToolName(name) || !description || !command) {
      continue;
    }
    const mcpServer = normalizeString(agentTool?.mcp?.server);
    const mcpTool = normalizeString(agentTool?.mcp?.tool);
    descriptors.set(`${entry.pluginId}\0${name}\0${command}`, {
      pluginId: entry.pluginId,
      name,
      description,
      parameters: normalizeRecord(agentTool?.parameters) ?? defaultParameters(),
      command,
      ...(mcpServer && mcpTool ? { mcp: { server: mcpServer, tool: mcpTool } } : {}),
    });
  }
  return descriptors;
}

export function normalizeNodePluginToolDescriptors(params: {
  tools?: readonly NodePluginToolDescriptor[];
  allowedCommands?: readonly string[];
}): NodePluginToolDescriptor[] {
  const allowedCommands = params.allowedCommands ? new Set(params.allowedCommands) : undefined;
  const registeredToolDescriptors = listRegisteredNodePluginToolDescriptors();
  const byKey = new Map<string, NodePluginToolDescriptor>();
  for (const tool of params.tools ?? []) {
    const pluginId = normalizeString(tool.pluginId);
    const name = normalizeString(tool.name);
    const command = normalizeString(tool.command);
    if (!pluginId || !isProviderSafeToolName(name) || !command) {
      continue;
    }
    const registeredDescriptor = registeredToolDescriptors.get(`${pluginId}\0${name}\0${command}`);
    if (!registeredDescriptor) {
      continue;
    }
    if (allowedCommands && !allowedCommands.has(command)) {
      continue;
    }
    byKey.set(`${pluginId}\0${name}`, registeredDescriptor);
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.pluginId.localeCompare(right.pluginId) || left.name.localeCompare(right.name),
  );
}

export function replaceConnectedNodePluginTools(params: {
  nodeId: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  tools: readonly NodePluginToolDescriptor[];
}): void {
  if (params.tools.length === 0) {
    toolsByNodeId.delete(params.nodeId);
    return;
  }
  toolsByNodeId.set(
    params.nodeId,
    params.tools.map((descriptor) => ({
      nodeId: params.nodeId,
      displayName: params.displayName,
      platform: params.platform,
      remoteIp: params.remoteIp,
      descriptor,
    })),
  );
}

export function removeConnectedNodePluginTools(nodeId: string): void {
  toolsByNodeId.delete(nodeId);
}

export function listConnectedNodePluginTools(): ConnectedNodePluginTool[] {
  return [...toolsByNodeId.values()]
    .flat()
    .toSorted(
      (left, right) =>
        left.descriptor.pluginId.localeCompare(right.descriptor.pluginId) ||
        left.descriptor.name.localeCompare(right.descriptor.name) ||
        left.nodeId.localeCompare(right.nodeId),
    );
}

export function resetConnectedNodePluginToolsForTest(): void {
  toolsByNodeId.clear();
}
