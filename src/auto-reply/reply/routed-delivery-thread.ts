import { parseThreadSessionSuffix } from "../../routing/session-key.js";
import type { MsgContext } from "../templating.js";

export function resolveRoutedDeliveryThreadId(params: {
  ctx: MsgContext;
  sessionKey?: string;
}): string | number | undefined {
  if (params.ctx.MessageThreadId != null) {
    return params.ctx.MessageThreadId;
  }
  if (params.ctx.TransportThreadId != null) {
    return params.ctx.TransportThreadId;
  }
  return parseThreadSessionSuffix(params.sessionKey).threadId;
}
