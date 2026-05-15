import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionTranscriptUpdate, onSessionTranscriptUpdate } from "./transcript-events.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("transcript events", () => {
  it("emits trimmed session-scope updates", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      agentId: "  main  ",
      sessionId: "  session  ",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "session",
    });
  });

  it("includes optional session metadata when provided", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      agentId: "  main  ",
      sessionId: "  sess-1  ",
      sessionKey: "  agent:main:main  ",
      message: { role: "assistant", content: "hi" },
      messageId: "  msg-1  ",
    });

    expect(listener).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: "hi" },
      messageId: "msg-1",
    });
  });

  it("drops invalid message sequence values", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionId: "session",
      messageSeq: 0,
    });
    emitSessionTranscriptUpdate({
      sessionId: "session",
      messageSeq: 1.5,
    });
    emitSessionTranscriptUpdate({
      sessionId: "session",
      messageSeq: Number.POSITIVE_INFINITY,
    });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, { sessionId: "session" });
    expect(listener).toHaveBeenNthCalledWith(2, { sessionId: "session" });
    expect(listener).toHaveBeenNthCalledWith(3, { sessionId: "session" });
  });

  it("continues notifying other listeners when one throws", () => {
    const first = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(first));
    cleanup.push(onSessionTranscriptUpdate(second));

    expect(
      emitSessionTranscriptUpdate({
        agentId: "main",
        sessionId: "session",
      }),
    ).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
