import { describe, expect, it } from "vitest";
import { validateScopedQuery } from "./customQueryValidation.js";

/**
 * Attempts to break the scoped-query sandbox.
 *
 * Tenancy rests entirely on this validator: `executeScopedQuery` wraps whatever
 * passes it in `WITH scoped_events AS (SELECT * FROM events PREWHERE site_id IN
 * {siteIds})`. So a single accepted query that names a real table, redefines the
 * CTE, or truncates the wrapper is a cross-tenant read.
 */
const reachRealTable = [
  ["plain", "SELECT * FROM events"],
  ["union", "SELECT * FROM scoped_events UNION ALL SELECT * FROM events"],
  ["cte wrapper", "WITH x AS (SELECT * FROM events) SELECT * FROM x"],
  ["subquery in IN", "SELECT * FROM scoped_events WHERE session_id IN (SELECT session_id FROM events)"],
  ["IN table shorthand", "SELECT * FROM scoped_events WHERE session_id IN events"],
  ["nested subquery", "SELECT * FROM (SELECT * FROM events)"],
  ["comma list", "SELECT * FROM scoped_events, events"],
  ["join", "SELECT * FROM scoped_events JOIN events ON 1=1"],
  ["mixed case", "SELECT * FROM ScOpEd_EvEnTs, EvEnTs"],
  ["system table", "SELECT * FROM system.tables"],
  ["scalar subquery", "SELECT * FROM scoped_events WHERE 1 = (SELECT count() FROM events)"],
  ["db qualified", "SELECT * FROM default.events"],
  ["cte then union", "WITH x AS (SELECT 1 AS a) SELECT * FROM scoped_events UNION ALL SELECT * FROM x, events"],
  ["array join", "SELECT * FROM scoped_events ARRAY JOIN events"],
  ["order by subq", "SELECT * FROM scoped_events ORDER BY (SELECT * FROM events)"],
];

const redefine = [
  ["redefine cte", "WITH scoped_events AS (SELECT * FROM events) SELECT * FROM scoped_events"],
  ["redefine aliased", "WITH x AS (SELECT * FROM events) SELECT * FROM scoped_events, x AS scoped_events"],
];

// A trailing comment is accepted by the validator but cannot escape anything: the
// wrapper's closing paren and LIMIT end up inside the comment, so what reaches
// ClickHouse is an unbalanced parenthesis and the database rejects it. Verified on
// staging — error 62, SYNTAX_ERROR, no rows. Kept here as a regression note.
// What does have to be refused is a comment used to hide a table from the scanner.
const commentObfuscation = [
  ["comment before from", "SELECT * FROM scoped_events --\n, events"],
  ["comment splits name", "SELECT * FROM scoped_events JOIN ev/**/ents ON 1=1"],
  ["array join alias", "SELECT * FROM scoped_events ARRAY JOIN events AS e"],
];

const infra = [
  ["file read", "SELECT * FROM file('/etc/passwd')"],
  ["url fetch", "SELECT * FROM url('http://169.254.169.254/latest/meta-data/')"],
  ["settings", "SELECT * FROM scoped_events SETTINGS max_threads=100"],
  ["dictionary", "SELECT * FROM scoped_events WHERE country IN dictGet('d', 'k', 'UInt8')"],
  ["format", "SELECT * FROM scoped_events FORMAT JSON"],
  ["multi statement", "SELECT * FROM scoped_events; SELECT * FROM events"],
  ["insert", "INSERT INTO scoped_events SELECT * FROM events"],
  ["ddl", "DROP TABLE events"],
];

// `it.each` spreads a row into separate arguments.
const refuse = (name: string, sql: string) => {
  expect(validateScopedQuery(sql), `${name} should be refused: ${sql}`).not.toBeNull();
};

describe("the scoped-query sandbox", () => {
  it.each(reachRealTable)("refuses to %s", refuse);
  it.each(redefine)("refuses to %s", refuse);
  it.each(commentObfuscation)("refuses to %s", refuse);
  it("documents that trailing comments are harmless", () => {
    expect(validateScopedQuery("SELECT * FROM scoped_events --")).toBeNull();
  });
  it.each(infra)("refuses to %s", refuse);
});

describe("legitimate queries still work", () => {
  const ok = [
    "SELECT count() FROM scoped_events",
    "SELECT pathname, count() FROM scoped_events GROUP BY pathname ORDER BY count() DESC LIMIT 10",
    "WITH a AS (SELECT 1 AS n) SELECT * FROM a, scoped_events",
    "SELECT * FROM scoped_events WHERE pathname = '/pricing'",
    "SELECT * FROM scoped_events WHERE path LIKE '%/blog/%'",
    "SELECT toStartOfHour(timestamp) h, count() FROM scoped_events GROUP BY h",
  ];
  it.each(ok)("allows %s", sql => {
    expect(validateScopedQuery(sql)).toBeNull();
  });
});
