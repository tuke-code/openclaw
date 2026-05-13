import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import {
  classifySilentReplyConversationType,
  resolveSilentReplyPolicyFromPolicies,
  type SilentReplyConversationType,
  type SilentReplyPolicy,
  type SilentReplyPolicyShape,
} from "../shared/silent-reply-policy.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type ResolveSilentReplyParams = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
};

function deriveSilentReplyConversationTypeFromSessionKey(
  sessionKey: string | undefined,
): SilentReplyConversationType | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest ?? sessionKey;
  const parts = normalizeLowercaseStringOrEmpty(rest).split(":");
  for (const part of parts) {
    if (part === "direct" || part === "dm") {
      return "direct";
    }
    if (part === "group" || part === "channel") {
      return "group";
    }
  }
  return undefined;
}

function resolveSilentReplyConversationContext(params: ResolveSilentReplyParams): {
  conversationType: SilentReplyConversationType;
  defaultPolicy?: SilentReplyPolicyShape;
  surfacePolicy?: SilentReplyPolicyShape;
} {
  const conversationType = classifySilentReplyConversationType({
    surface: params.surface,
    conversationType:
      params.conversationType ?? deriveSilentReplyConversationTypeFromSessionKey(params.sessionKey),
  });
  const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
  const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : undefined;
  return {
    conversationType,
    defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
    surfacePolicy: surface?.silentReply,
  };
}

export function resolveSilentReplySettings(params: ResolveSilentReplyParams): {
  policy: SilentReplyPolicy;
} {
  const context = resolveSilentReplyConversationContext(params);
  return {
    policy: resolveSilentReplyPolicyFromPolicies(context),
  };
}

export function resolveSilentReplyPolicy(params: ResolveSilentReplyParams): SilentReplyPolicy {
  return resolveSilentReplySettings(params).policy;
}
