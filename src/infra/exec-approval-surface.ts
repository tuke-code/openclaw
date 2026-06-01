import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

/** Native approval availability for the channel that initiated an approval request. */
export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string; accountId?: string }
  | { kind: "disabled"; channel: string; channelLabel: string; accountId?: string }
  | { kind: "unsupported"; channel: string; channelLabel: string; accountId?: string };

type ApprovalKind = "exec" | "plugin";

function labelForChannel(channel?: string): string {
  if (channel === "tui") {
    return "terminal UI";
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return "Web UI";
  }
  return (
    getChannelPlugin(channel ?? "")?.meta.label ??
    (channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform")
  );
}

function hasNativeExecApprovalCapability(channel?: string): boolean {
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel ?? ""));
  if (!capability?.native) {
    return false;
  }
  return Boolean(capability.getExecInitiatingSurfaceState || capability.getActionAvailabilityState);
}

/** Resolves whether the initiating surface can collect a native exec approval. */
export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState {
  return resolveApprovalInitiatingSurfaceState({ ...params, approvalKind: "exec" });
}

/** Resolve whether the initiating channel can collect a native approval for this approval kind. */
export function resolveApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
  approvalKind: ApprovalKind;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  const accountId = normalizeOptionalString(params.accountId);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel, accountId };
  }

  const cfg = params.cfg ?? getRuntimeConfig();
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  // Exec-specific availability predates the generic action hook; prefer it when present so
  // existing plugins keep their narrower approval semantics.
  const state =
    (params.approvalKind === "exec"
      ? capability?.getExecInitiatingSurfaceState?.({
          cfg,
          accountId: params.accountId,
          action: "approve",
        })
      : undefined) ??
    capability?.getActionAvailabilityState?.({
      cfg,
      accountId: params.accountId,
      action: "approve",
      approvalKind: params.approvalKind,
    });
  if (state) {
    return { ...state, channel, channelLabel, accountId };
  }
  if (isDeliverableMessageChannel(channel)) {
    return { kind: "enabled", channel, channelLabel, accountId };
  }
  return { kind: "unsupported", channel, channelLabel, accountId };
}

/** Return whether a channel has native exec approval support or is a built-in UI surface. */
export function supportsNativeExecApprovalClient(channel?: string | null): boolean {
  const normalized = normalizeMessageChannel(channel);
  if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL || normalized === "tui") {
    return true;
  }
  return hasNativeExecApprovalCapability(normalized);
}

/** List configured/native approval-capable channel labels for fallback guidance. */
export function listNativeExecApprovalClientLabels(params?: {
  excludeChannel?: string | null;
}): string[] {
  const excludeChannel = normalizeMessageChannel(params?.excludeChannel);
  return listChannelPlugins()
    .filter((plugin) => plugin.id !== excludeChannel)
    .filter((plugin) => hasNativeExecApprovalCapability(plugin.id))
    .map((plugin) => normalizeOptionalString(plugin.meta.label))
    .filter((label): label is string => Boolean(label))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Ask the channel plugin for setup guidance for native exec approvals, when available. */
export function describeNativeExecApprovalClientSetup(params: {
  channel?: string | null;
  channelLabel?: string | null;
  accountId?: string | null;
}): string | null {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return null;
  }
  const channelLabel = normalizeOptionalString(params.channelLabel) ?? labelForChannel(channel);
  const accountId = normalizeOptionalString(params.accountId);
  return (
    resolveChannelApprovalCapability(getChannelPlugin(channel))?.describeExecApprovalSetup?.({
      channel,
      channelLabel,
      accountId,
    }) ?? null
  );
}
