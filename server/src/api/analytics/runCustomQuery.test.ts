import { beforeEach, describe, expect, it, vi } from "vitest";
import { clickhouseQuery } from "../../db/clickhouse/clickhouse.js";
import { executeScopedQuery } from "./runCustomQuery.js";
import { validateScopedQuery } from "./utils/customQueryValidation.js";

vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouseQuery: { query: vi.fn() },
}));

// executeScopedQuery's module pulls in the auth chain, which resolves a base URL
// at import time. Only executeScopedQuery is under test here; the handler is not.
vi.mock("../../lib/auth-utils.js", () => ({
  getSitesUserHasAccessTo: async () => [],
}));

describe("validateScopedQuery", () => {
  it("allows SELECT queries against scoped_events", () => {
    expect(validateScopedQuery("SELECT event_name, count() FROM scoped_events GROUP BY event_name")).toBeNull();
  });

  it("allows aliases that use blocked table names", () => {
    expect(validateScopedQuery("SELECT event_name, count() AS events FROM scoped_events GROUP BY event_name")).toBeNull();
  });

  it("allows WITH expressions that read from scoped_events", () => {
    expect(
      validateScopedQuery(`
        WITH event_name AS name
        SELECT name, count()
        FROM scoped_events
        GROUP BY name
      `)
    ).toBeNull();
  });

  it("allows CTEs derived from scoped_events", () => {
    expect(
      validateScopedQuery(`
        WITH top_events AS (
          SELECT event_name, count() AS event_count
          FROM scoped_events
          GROUP BY event_name
        )
        SELECT *
        FROM top_events
      `)
    ).toBeNull();
  });

  it("rejects direct reads from events", () => {
    expect(validateScopedQuery("SELECT count() FROM events")).toBe("Queries can only read from scoped_events");
  });

  it("rejects comma joins to other tables", () => {
    expect(validateScopedQuery("SELECT count() FROM scoped_events, hourly_events_by_site_mv_target")).toBe(
      "Queries can only read from scoped_events"
    );
  });

  it("rejects multiple statements", () => {
    expect(validateScopedQuery("SELECT count() FROM scoped_events; SELECT count() FROM scoped_events")).toBe(
      "Only one SQL statement is allowed"
    );
  });

  it("ignores blocked words inside string literals", () => {
    expect(validateScopedQuery("SELECT 'DROP TABLE events' AS label FROM scoped_events LIMIT 1")).toBeNull();
  });

  it("rejects redefining scoped_events", () => {
    expect(validateScopedQuery("WITH scoped_events AS (SELECT * FROM events) SELECT * FROM scoped_events")).toBe(
      "scoped_events is reserved and cannot be redefined"
    );
  });

  it("rejects table functions", () => {
    expect(validateScopedQuery("SELECT * FROM scoped_events UNION ALL SELECT * FROM s3('https://example.com')")).toBe(
      "s3() is not allowed in custom analytics queries"
    );
  });
});

/**
 * The wrapper `executeScopedQuery` builds, not the validator. Tenancy is decided
 * by that wrapper: the caller's sites arrive as a bound parameter, so no query
 * text can widen them, and a single-site scope hides `site_id` so a query cannot
 * name a tenant it was not given.
 */
describe("executeScopedQuery", () => {
  const sent = () => vi.mocked(clickhouseQuery.query).mock.calls[0][0] as { query: string; query_params: Record<string, unknown> };

  beforeEach(() => {
    vi.mocked(clickhouseQuery.query).mockReset();
    vi.mocked(clickhouseQuery.query).mockResolvedValue({
      json: async () => [],
      query_id: "q1",
    } as never);
  });

  it("binds the caller's sites as a parameter instead of naming them in SQL", async () => {
    await executeScopedQuery("SELECT count() FROM scoped_events", [1]);
    const { query, query_params } = sent();
    expect(query_params.siteIds).toEqual([1]);
    // A literal id in the text would be the one thing a query could not outvote.
    expect(query).not.toMatch(/\b1\b/);
    expect(query).toContain("site_id IN {siteIds:Array(UInt16)}");
  });

  it("hides site_id from a single-site scope, so a query cannot name another tenant", async () => {
    await executeScopedQuery("SELECT count() FROM scoped_events", [1]);
    expect(sent().query).toContain("* EXCEPT (site_id)");
  });

  it("keeps site_id when the scope spans several sites", async () => {
    await executeScopedQuery("SELECT site_id, count() FROM scoped_events GROUP BY site_id", [1, 2]);
    const { query } = sent();
    expect(query).toContain("* FROM events");
    expect(query).not.toContain("EXCEPT");
  });

  it("still refuses a query that reads a real table", async () => {
    await expect(executeScopedQuery("SELECT * FROM events", [1])).rejects.toThrow(
      "Queries can only read from scoped_events"
    );
    expect(clickhouseQuery.query).not.toHaveBeenCalled();
  });
});
