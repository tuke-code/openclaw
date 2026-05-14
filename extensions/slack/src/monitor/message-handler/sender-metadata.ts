import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

function formatSlackSenderMetadataPrefix(params: {
  senderId?: string | null;
  senderName?: string | null;
}): string | undefined {
  const id = normalizeOptionalString(params.senderId);
  const name = normalizeOptionalString(params.senderName);
  const payload: Record<string, string> = {};
  if (id) {
    payload.id = id;
  }
  if (name && name !== id) {
    payload.name = name;
  }
  if (Object.keys(payload).length === 0) {
    return undefined;
  }
  return `Sender (untrusted metadata): ${JSON.stringify(payload)}`;
}

export function prependSlackSenderMetadata(
  body: string,
  params: {
    enabled: boolean;
    senderId?: string | null;
    senderName?: string | null;
  },
): string {
  if (!params.enabled) {
    return body;
  }
  const prefix = formatSlackSenderMetadataPrefix(params);
  return prefix ? `${prefix}\n${body}` : body;
}
