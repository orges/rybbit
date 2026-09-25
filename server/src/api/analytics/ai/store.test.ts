import { describe, expect, it, vi } from "vitest";

vi.mock("../../../db/postgres/postgres.js", () => ({ db: {} }));
vi.mock("../../../db/postgres/schema.js", () => ({
  aiConversations: {},
  aiFeedback: {},
  aiMemories: {},
  aiMessages: {},
  aiRuns: {},
}));

import { toClientMessage } from "./store.js";

describe("toClientMessage", () => {
  it("lifts a stored assistant turn's tool trail, artifacts and usage onto the message", () => {
    const message = toClientMessage({
      id: "m1",
      role: "assistant",
      content: "Traffic is down.",
      parts: {
        reasoning: "checking the numbers",
        toolCalls: [{ id: "t1", name: "get_overview", ok: true, summary: "range: today", durationMs: 120 }],
        artifacts: [{ type: "table", title: "Top pages", columns: ["value"], rows: [["/"]], total: 1, truncated: false }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        model: "some-model",
      } as never,
    });

    expect(message).toEqual({
      id: "m1",
      role: "assistant",
      content: "Traffic is down.",
      reasoning: "checking the numbers",
      toolCalls: [{ id: "t1", name: "get_overview", ok: true, summary: "range: today", durationMs: 120 }],
      artifacts: [{ type: "table", title: "Top pages", columns: ["value"], rows: [["/"]], total: 1, truncated: false }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      model: "some-model",
    });
  });

  it("keeps the dashboard context on a user turn", () => {
    const message = toClientMessage({
      id: "u1",
      role: "user",
      content: "top pages?",
      parts: { context: { startDate: "2026-09-19", endDate: "2026-09-25" } } as never,
    });
    expect(message).toMatchObject({ role: "user", context: { startDate: "2026-09-19" } });
  });

  it("omits empty parts rather than sending nulls", () => {
    expect(toClientMessage({ id: "u2", role: "user", content: "hi", parts: {} as never })).toEqual({
      id: "u2",
      role: "user",
      content: "hi",
      context: undefined,
    });
  });
});
