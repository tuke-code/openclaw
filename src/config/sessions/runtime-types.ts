import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionEntry, GroupKeyResolution } from "./types.js";

export type ReadSessionUpdatedAt = (params: {
  agentId?: string;
  sessionKey: string;
}) => number | undefined;

export type RecordSessionMetaFromInbound = (params: {
  agentId?: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;

export type UpdateLastRoute = (params: {
  agentId?: string;
  sessionKey: string;
  channel?: SessionEntry["channel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;
