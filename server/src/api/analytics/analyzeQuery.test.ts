import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
const { getSitesUserHasAccessTo } = vi.hoisted(() => ({ getSitesUserHasAccessTo: vi.fn() }));
const { streamOpenRouter } = vi.hoisted(() => ({ streamOpenRouter: vi.fn() }));
vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouseQuery: { query } }));
vi.mock("../../lib/auth-utils.js", () => ({ getSitesUserHasAccessTo }));
vi.mock("../../lib/openrouter.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/openrouter.js")>()),
  streamOpenRouter,
}));

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
    streamOpenRouter.mockImplementation(async function* () {
      yield "Four ";
      yield "visits";
    });
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
    expect(lines.map(line => JSON.parse(line.slice(6)).type)).toEqual(["result", "delta", "delta", "done"]);
    expect(JSON.parse(lines[0].slice(6)).rows).toEqual([{ visits: 4 }]);
    expect(raw.end).toHaveBeenCalledOnce();
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
