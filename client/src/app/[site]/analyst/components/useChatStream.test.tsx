"use client";

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "@/api/analyst/endpoints/analyst";
import { useChatStream } from "./useChatStream";

const { streamAnalystMessage } = vi.hoisted(() => ({ streamAnalystMessage: vi.fn() }));

vi.mock("@/api/analyst/endpoints/analyst", async importOriginal => {
  const actual = await importOriginal<typeof import("@/api/analyst/endpoints/analyst")>();
  return { ...actual, streamAnalystMessage };
});

const context = { startDate: "2026-09-19", endDate: "2026-09-25", timeZone: "UTC", filters: [] };
const lastAssistant = (messages: Array<{ role: string }>) => messages.filter(m => m.role === "assistant").at(-1);

function renderStream(options: { onRunSettled?: (conversationId: string | null) => void } = {}) {
  return renderHook(() => useChatStream({ organizationId: "org-1", siteId: 42, context, ...options }));
}

const emit = (events: ChatStreamEvent[]) => {
  streamAnalystMessage.mockImplementation(async (...args: unknown[]) => {
    const onEvent = args[3] as ((event: ChatStreamEvent) => void) | undefined;
    // Vitest's own assertion machinery pokes the mock with no arguments; only
    // the four-argument call from the hook is a real run.
    if (!onEvent) return;
    for (const event of events) onEvent(event);
  });
};

describe("useChatStream", () => {
  beforeEach(() => streamAnalystMessage.mockReset());

  it("folds reasoning, text, tool activity and the final id into one message", async () => {
    emit([
      { type: "conversation", conversationId: "c1" },
      { type: "reasoning_delta", text: "checking" },
      { type: "tool_start", id: "t1", name: "get_overview", input: { time: { preset: "today" } } },
      { type: "tool_end", id: "t1", name: "get_overview", ok: true, summary: "r1 · range: today", durationMs: 42 },
      { type: "text_delta", text: "Sessions " },
      { type: "text_delta", text: "were 1,204." },
      { type: "message_id", messageId: "m1" },
      { type: "done", stopped: false, steps: 2 },
    ]);

    const { result } = renderStream();
    await act(async () => {
      await result.current.send("how many sessions?");
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));
    const [user, assistant] = result.current.messages;
    expect(user).toMatchObject({ role: "user", content: "how many sessions?", context: expect.objectContaining({ startDate: "2026-09-19" }) });
    expect(assistant).toMatchObject({ id: "m1", role: "assistant", content: "Sessions were 1,204.", reasoning: "checking", pending: false });
    expect(assistant.toolCalls).toEqual([
      { id: "t1", name: "get_overview", input: { time: { preset: "today" } }, ok: true, summary: "r1 · range: today", durationMs: 42, status: "done" },
    ]);
    expect(result.current.conversationId).toBe("c1");
  });

  it("keeps the partial answer when the user stops mid-stream", async () => {
    const controller = new AbortController();
    streamAnalystMessage.mockImplementation(async (...args: unknown[]) => {
      const onEvent = args[3] as (event: ChatStreamEvent) => void;
      if (!onEvent) return;
      const signal = args[2] as AbortSignal;
      onEvent({ type: "text_delta", text: "Sessions " });
      expect(signal.aborted).toBe(false);
      controller.abort();
      expect(signal.aborted).toBe(true);
    });

    const { result } = renderStream();
    await act(async () => {
      await result.current.send("count sessions");
    });

    expect(lastAssistant(result.current.messages)).toMatchObject({ content: "Sessions ", pending: false });
    expect(result.current.streaming).toBe(false);
  });

  it("shows the error on the message instead of dropping the turn", async () => {
    streamAnalystMessage.mockImplementation(async (...args: unknown[]) => {
      if (!args[3]) return;
      throw new Error("The analyst is unavailable (502)");
    });

    const { result } = renderStream();
    await act(async () => {
      await result.current.send("count sessions");
    });

    expect(lastAssistant(result.current.messages)).toMatchObject({ error: "The analyst is unavailable (502)", pending: false });
    expect(result.current.messages).toHaveLength(2);
  });

  it("drops prose from a step that also called a tool, since the model repeats it", async () => {
    const preamble = "Traffic is down 63%. ";
    emit([
      { type: "text_delta", text: preamble },
      { type: "tool_start", id: "t1", name: "get_overview", input: {} },
      { type: "tool_end", id: "t1", name: "get_overview", ok: true, summary: "range: this week", durationMs: 40 },
      { type: "text_discard", chars: preamble.length },
      { type: "text_delta", text: "Sessions fell from 23,881 to 8,731." },
      { type: "done", stopped: false, steps: 2 },
    ]);

    const { result } = renderStream();
    await act(async () => {
      await result.current.send("where did we lose visitors?");
    });

    expect(lastAssistant(result.current.messages)).toMatchObject({ content: "Sessions fell from 23,881 to 8,731." });
  });

  it("replaces the previous answer on a retry instead of appending a second one", async () => {
    emit([
      { type: "text_delta", text: "first" },
      { type: "done", stopped: false, steps: 1 },
    ]);
    const { result } = renderStream();
    await act(async () => {
      await result.current.send("count sessions");
    });
    emit([{ type: "text_delta", text: "second" }, { type: "done", stopped: false, steps: 1 }]);
    await act(async () => {
      await result.current.send("count sessions", { regenerate: true });
    });

    expect(result.current.messages.map(message => message.content)).toEqual(["count sessions", "second"]);
  });
  it("replaces a question and everything after it when the question is edited", async () => {
    emit([
      { type: "user_message_id", messageId: "q1" },
      { type: "text_delta", text: "first answer" },
      { type: "message_id", messageId: "m1" },
      { type: "done", stopped: false, steps: 1 },
    ]);
    const { result } = renderStream();
    await act(async () => {
      await result.current.send("count sessions");
    });
    expect(result.current.messages[0].id).toBe("q1");
    emit([
      { type: "user_message_id", messageId: "q2" },
      { type: "text_delta", text: "second answer" },
      { type: "done", stopped: false, steps: 1 },
    ]);
    await act(async () => {
      await result.current.send("count sessions last 7 days", { editOfMessageId: "q1" });
    });

    expect(result.current.messages.map(message => message.content)).toEqual(["count sessions last 7 days", "second answer"]);
    expect(streamAnalystMessage.mock.calls[1][1]).toMatchObject({ editOfMessageId: "q1" });
  });
});

describe("answer verification", () => {
  it("marks figures the stream reported as unverified", async () => {
    emit([
      { type: "text_delta", text: "Sessions were 19,048 and users were 21,904." },
      { type: "unverified", figures: ["21,904"] },
      { type: "done", stopped: false, steps: 1 },
    ]);
    const { result } = renderStream();
    await act(async () => {
      await result.current.send("how many users?");
    });
    expect(lastAssistant(result.current.messages)).toMatchObject({ unverified: ["21,904"] });
  });
});

describe("a run outlives the thread you are looking at", () => {
  /** A stream that stays open until the test releases it. */
  function pendingStream() {
    const gates: Array<() => void> = [];
    streamAnalystMessage.mockImplementation(
      (...args: unknown[]) =>
        new Promise<void>(resolve => {
          const onEvent = args[3] as (event: ChatStreamEvent) => void;
          onEvent?.({ type: "conversation", conversationId: "c1" });
          gates.push(() => {
            onEvent?.({ type: "text_delta", text: "The answer." });
            onEvent?.({ type: "done", stopped: false, steps: 1 });
            resolve();
          });
        })
    );
    return gates;
  }

  it("keeps running after another thread is opened, and reports when it lands", async () => {
    const gates = pendingStream();
    const onRunSettled = vi.fn();
    const { result } = renderStream({ onRunSettled });

    await act(async () => {
      void result.current.send("count sessions");
    });
    expect(result.current.streaming).toBe(true);

    // The reader gives up on this thread and opens another. The run is not ours
    // to cancel — the stop button is.
    act(() => {
      result.current.load([], "c2");
    });
    expect(result.current.liveThreads).toContain("c1");
    expect(result.current.streaming).toBe(false);

    await act(async () => {
      gates[0]();
    });

    // It finished in c1, which is not the thread on screen, so no refresh here.
    expect(onRunSettled).toHaveBeenCalledWith("c1");
    expect(result.current.liveThreads).toEqual([]);
  });

  it("refreshes the thread on screen when its own run finishes", async () => {
    const gates = pendingStream();
    const onRunSettled = vi.fn();
    const { result } = renderStream({ onRunSettled });

    await act(async () => {
      void result.current.send("count sessions");
    });
    act(() => {
      result.current.load([], "c1");
    });
    await act(async () => {
      gates[0]();
    });
    expect(onRunSettled).toHaveBeenCalledWith("c1");
  });
});
