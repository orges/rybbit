import { describe, expect, it, vi } from "vitest";

const { db, inArray } = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  inArray: vi.fn((_column: unknown, values: string[]) => ({ values })),
}));

vi.mock("../../../db/postgres/postgres.js", () => ({ db }));
vi.mock("drizzle-orm", async importOriginal => ({ ...(await importOriginal<typeof import("drizzle-orm")>()), inArray }));
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

describe("asUtcIso", () => {
  it("marks a bare wall-clock timestamp as UTC", async () => {
    const { asUtcIso } = await import("./store.js");
    expect(asUtcIso("2026-09-25 19:35:23.832")).toBe("2026-09-25T19:35:23.832Z");
  });

  it("leaves a value that already carries an offset alone", async () => {
    const { asUtcIso } = await import("./store.js");
    expect(asUtcIso("2026-09-25T19:35:23.832Z")).toBe("2026-09-25T19:35:23.832Z");
    expect(asUtcIso("2026-09-25T21:35:23.832+02:00")).toBe("2026-09-25T21:35:23.832+02:00");
    expect(asUtcIso(undefined)).toBeUndefined();
  });
});

describe("truncateAfter", () => {
  /** The query chain store.ts builds, returning `rows` and recording the delete. */
  const stub = (rows: Array<{ id: string; role: string }>) => {
    inArray.mockClear();
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => Promise.resolve(rows),
      limit: () => Promise.resolve(rows),
    };
    db.select = chain.select;
    db.delete = () => ({ where: () => undefined });
    return () => inArray.mock.calls[0]?.[1] as string[] | undefined;
  };

  it("deletes the question being edited and every turn after it", async () => {
    const deleted = stub([
      { id: "q1", role: "user" },
      { id: "m1", role: "assistant" },
      { id: "q2", role: "user" },
      { id: "m2", role: "assistant" },
    ]);
    const { truncateAfter } = await import("./store.js");

    expect(await truncateAfter("c1", "q2")).toEqual({ ok: true, replacedOpening: false });
    expect(deleted()).toEqual(["q2", "m2"]);
  });

  it("reports that the thread's opening question was replaced, so it can be retitled", async () => {
    stub([
      { id: "q1", role: "user" },
      { id: "m1", role: "assistant" },
    ]);
    const { truncateAfter } = await import("./store.js");
    expect(await truncateAfter("c1", "q1")).toEqual({ ok: true, replacedOpening: true });
  });

  it("refuses an id from another thread, and refuses to edit an answer", async () => {
    stub([
      { id: "q1", role: "user" },
      { id: "m1", role: "assistant" },
    ]);
    const { truncateAfter } = await import("./store.js");
    expect(await truncateAfter("c1", "other-thread-id")).toEqual({ ok: false, reason: "message_not_found" });
    expect(await truncateAfter("c1", "m1")).toEqual({ ok: false, reason: "not_a_question" });
  });
});

describe("snippetAround", () => {
  it("shows the run of text around the match", async () => {
    const { __testing } = await import("./store.js");
    const content =
      "Traffic is down 63% compared to last week. Both sessions and pageviews declined noticeably, " +
      "and the decline is proportional across every channel we measured this week against last week.";
    expect(__testing.snippetAround(content, "proportional")).toBe(
      "…sions and pageviews declined noticeably, and the decline is proportional across every channel we " +
        "measured this week against last week."
    );
  });

  it("leads with the match when it is near the start", async () => {
    const { __testing } = await import("./store.js");
    expect(__testing.snippetAround("bounce rate fell to 34%", "bounce")).toBe("bounce rate fell to 34%");
  });

  it("escapes a LIKE wildcard so it is searched for literally", async () => {
    const { likeTerm } = await import("./store.js");
    expect(likeTerm("100%_bounce")).toBe("%100\\%\\_bounce%");
    expect(likeTerm("  padded  ")).toBe("%padded%");
  });
});
