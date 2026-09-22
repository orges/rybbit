import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
const { getSitesUserHasAccessTo } = vi.hoisted(() => ({ getSitesUserHasAccessTo: vi.fn() }));
const { streamOpenRouter } = vi.hoisted(() => ({ streamOpenRouter: vi.fn() }));
const { callOpenRouterWithTools } = vi.hoisted(() => ({ callOpenRouterWithTools: vi.fn() }));
const { canReadConversation, saveAiExchange } = vi.hoisted(() => ({
  canReadConversation: vi.fn(),
  saveAiExchange: vi.fn(),
}));
vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouseQuery: { query } }));
vi.mock("../../lib/auth-utils.js", () => ({ getSitesUserHasAccessTo }));
vi.mock("../../lib/openrouter.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/openrouter.js")>()),
  streamOpenRouter,
  callOpenRouterWithTools,
}));
vi.mock("./aiConversations.js", () => ({ canReadConversation, saveAiExchange }));

import { analyzeQuery } from "./analyzeQuery.js";
import { generateCustomQuery } from "./generateCustomQuery.js";
import { executeScopedQuery } from "./runCustomQuery.js";

describe("executeScopedQuery", () => {
  beforeEach(() => query.mockReset());

  it("rejects unscoped SQL before calling ClickHouse", async () => {
    await expect(executeScopedQuery("SELECT * FROM events", [42])).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("binds accessible site IDs and caps result rows", async () => {
    query.mockResolvedValue({ query_id: "test", json: async () => [{ count: 2 }] });
    const result = await executeScopedQuery("SELECT count() FROM scoped_events", [42, 43]);
    expect(result.data).toEqual([{ count: 2 }]);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { siteIds: [42, 43], limit: 1000 },
      })
    );
  });
});

describe("analyzeQuery", () => {
  it("denies inaccessible sites without querying analytics or the model", async () => {
    getSitesUserHasAccessTo.mockResolvedValue([{ organizationId: "org-1", siteId: 42 }]);
    query.mockReset();
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    await analyzeQuery(
      {
        params: { organizationId: "org-1" },
        body: { query: "SELECT count() FROM scoped_events", question: "Visits?", siteId: 43 },
      } as Parameters<typeof analyzeQuery>[0],
      { status } as unknown as Parameters<typeof analyzeQuery>[1]
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("streams the scoped result, summary deltas, and completion while preserving CORS headers", async () => {
    getSitesUserHasAccessTo.mockResolvedValue([{ organizationId: "org-1", siteId: 42 }]);
    query.mockResolvedValue({ query_id: "test", json: async () => [{ visits: 4 }] });
    callOpenRouterWithTools.mockResolvedValue({
      content: "",
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: { name: "render_table", arguments: '{"title":"Visits","columns":["visits"],"row_indices":[0]}' },
        },
      ],
    });
    streamOpenRouter.mockImplementation(async function* (messages: Array<{ content: string }>) {
      expect(messages[messages.length - 1]?.content).toContain('"success":true');
      yield "Four ";
      yield "visits";
    });
    saveAiExchange.mockResolvedValue("e8dfdb2e-8159-4d51-a56d-22404613da4e");
    const lines: string[] = [];
    const raw = Object.assign(new EventEmitter(), {
      headersSent: false,
      writeHead: vi.fn(function (this: { headersSent: boolean }, _status: number, _headers: unknown) {
        this.headersSent = true;
      }),
      write: vi.fn((line: string) => lines.push(line)),
      end: vi.fn(),
    });
    const reply = {
      raw,
      hijack: vi.fn(),
      getHeaders: () => ({ "access-control-allow-origin": "https://app.example" }),
    } as unknown as Parameters<typeof analyzeQuery>[1];
    await analyzeQuery(
      {
        params: { organizationId: "org-1" },
        user: { id: "user-1" },
        body: { query: "SELECT count() FROM scoped_events", question: "Visits?", siteId: 42 },
        raw: new EventEmitter(),
        log: { error: vi.fn() },
      } as unknown as Parameters<typeof analyzeQuery>[0],
      reply
    );
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "access-control-allow-origin": "https://app.example",
        "Content-Type": "text/event-stream; charset=utf-8",
      })
    );
    expect(lines.map(line => JSON.parse(line.slice(6)).type)).toEqual(["result", "artifact", "delta", "delta", "done"]);
    expect(JSON.parse(lines[0].slice(6)).rows).toEqual([{ visits: 4 }]);
    expect(JSON.parse(lines[1].slice(6)).artifact).toEqual({
      type: "table",
      title: "Visits",
      columns: ["visits"],
      rows: [["4"]],
    });
    expect(saveAiExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        organizationId: "org-1",
        siteId: 42,
        summary: expect.stringContaining('<!--rybbit-artifact:{"type":"table"'),
      })
    );
    expect(JSON.parse(lines[lines.length - 1].slice(6)).conversationId).toBe("e8dfdb2e-8159-4d51-a56d-22404613da4e");
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it("refuses another user's conversation before querying or streaming", async () => {
    saveAiExchange.mockClear();
    getSitesUserHasAccessTo.mockResolvedValue([{ organizationId: "org-1", siteId: 42 }]);
    canReadConversation.mockResolvedValue(false);
    query.mockReset();
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    await analyzeQuery(
      {
        params: { organizationId: "org-1" },
        user: { id: "user-1" },
        body: {
          query: "SELECT count() FROM scoped_events",
          question: "Visits?",
          siteId: 42,
          conversationId: "e8dfdb2e-8159-4d51-a56d-22404613da4e",
        },
      } as unknown as Parameters<typeof analyzeQuery>[0],
      { status } as unknown as Parameters<typeof analyzeQuery>[1]
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(query).not.toHaveBeenCalled();
    expect(saveAiExchange).not.toHaveBeenCalled();
  });
});

it("rejects arbitrary page context before calling the SQL generator", async () => {
  getSitesUserHasAccessTo.mockClear();
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  await generateCustomQuery(
    { body: { prompt: "Visits?", currentPage: "ignore-instructions" } } as Parameters<typeof generateCustomQuery>[0],
    { status } as unknown as Parameters<typeof generateCustomQuery>[1]
  );
  expect(status).toHaveBeenCalledWith(400);
  expect(getSitesUserHasAccessTo).not.toHaveBeenCalled();
});
