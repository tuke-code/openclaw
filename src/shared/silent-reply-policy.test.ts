import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENT_REPLY_POLICY,
  classifySilentReplyConversationType,
  resolveSilentReplyPolicyFromPolicies,
} from "./silent-reply-policy.js";

describe("classifySilentReplyConversationType", () => {
  it("prefers an explicit conversation type", () => {
    expect(
      classifySilentReplyConversationType({
        conversationType: "internal",
      }),
    ).toBe("internal");
  });

  it("does not infer conversation type from session key shape", () => {
    expect(classifySilentReplyConversationType({})).toBe("internal");
  });

  it("treats webchat as direct by default and unknown surfaces as internal", () => {
    expect(classifySilentReplyConversationType({ surface: "webchat" })).toBe("direct");
    expect(classifySilentReplyConversationType({ surface: "subagent" })).toBe("internal");
  });
});

describe("silent reply default policy resolution", () => {
  it("uses defaults when no overrides exist", () => {
    expect(resolveSilentReplyPolicyFromPolicies({ conversationType: "direct" })).toBe(
      DEFAULT_SILENT_REPLY_POLICY.direct,
    );
    expect(resolveSilentReplyPolicyFromPolicies({ conversationType: "group" })).toBe(
      DEFAULT_SILENT_REPLY_POLICY.group,
    );
  });
});

describe("resolveSilentReplyPolicyFromPolicies", () => {
  it("prefers surface policy over defaults", () => {
    expect(
      resolveSilentReplyPolicyFromPolicies({
        conversationType: "group",
        defaultPolicy: { group: "allow" },
        surfacePolicy: { group: "disallow" },
      }),
    ).toBe("disallow");
  });

  it("always disallows direct silent replies", () => {
    expect(
      resolveSilentReplyPolicyFromPolicies({
        conversationType: "direct",
        defaultPolicy: { group: "allow" },
        surfacePolicy: { group: "allow" },
      }),
    ).toBe("disallow");
  });
});
