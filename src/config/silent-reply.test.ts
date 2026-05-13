import { describe, expect, it } from "vitest";
import { resolveSilentReplyPolicy } from "./silent-reply.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("silent reply config resolution", () => {
  it("uses the default direct/group/internal policy", () => {
    expect(resolveSilentReplyPolicy({ surface: "webchat" })).toBe("disallow");
    expect(
      resolveSilentReplyPolicy({
        surface: "telegram",
        conversationType: "group",
      }),
    ).toBe("allow");
    expect(
      resolveSilentReplyPolicy({
        sessionKey: "agent:main:subagent:abc",
      }),
    ).toBe("allow");
  });

  it("applies configured defaults by conversation type", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "disallow",
            internal: "allow",
          },
        },
      },
    };

    expect(resolveSilentReplyPolicy({ cfg, surface: "webchat" })).toBe("disallow");
    expect(
      resolveSilentReplyPolicy({
        cfg,
        surface: "discord",
        conversationType: "group",
      }),
    ).toBe("disallow");
  });

  it("lets surface overrides beat the default policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "allow",
          },
        },
      },
      surfaces: {
        telegram: {
          silentReply: {
            group: "disallow",
          },
        },
      },
    };

    expect(
      resolveSilentReplyPolicy({
        cfg,
        surface: "telegram",
        conversationType: "group",
      }),
    ).toBe("disallow");
  });
});
