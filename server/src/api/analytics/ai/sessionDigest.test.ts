import { describe, expect, it } from "vitest";
import { ALLOWED_PROPS, digestForModel, digestSession, type SessionDigest, type TimelineRow } from "./sessionDigest.js";
import { buildSessionTimelineQuery, SESSION_TOOLS, windowFor } from "./sessionTools.js";
import type { ToolContext } from "./tools.js";
import { validateFilters } from "../utils/query-validation.js";

/** Milliseconds, so a test can write a session as a readable sequence. */
const at = (seconds: number) => seconds * 1000;

const pageview = (seconds: number, pathname: string): TimelineRow => ({ timestamp: at(seconds), type: "pageview", pathname });
const click = (seconds: number, pathname: string, label: string): TimelineRow => ({
  timestamp: at(seconds),
  type: "button_click",
  pathname,
  props: { text: label, rybbitCampaign: "spring" },
});
const input = (seconds: number, pathname: string, inputName: string, inputType = "text"): TimelineRow => ({
  timestamp: at(seconds),
  type: "input_change",
  pathname,
  props: { inputName, inputType, element: "input", formName: "checkout" },
});
const submit = (seconds: number, pathname: string, formName: string): TimelineRow => ({
  timestamp: at(seconds),
  type: "form_submit",
  pathname,
  props: { formName, formId: "checkout-1" },
});

describe("digestSession", () => {
  it("reads the path in order with time spent on each page", () => {
    const digest = digestSession([pageview(0, "/"), pageview(30, "/pricing"), pageview(45, "/checkout")], { endTimestamp: at(60) });
    expect(digest.steps).toEqual([
      { path: "/", at: 0, dwell: 30, views: 1 },
      { path: "/pricing", at: 30, dwell: 15, views: 1 },
      { path: "/checkout", at: 45, dwell: 15, views: 1 },
    ]);
    expect(digest.entryPage).toBe("/");
    expect(digest.exitPage).toBe("/checkout");
    expect(digest.durationSeconds).toBe(60);
  });

  it("counts a page the visitor never left as one visit, not one per pageview", () => {
    // A soft navigation or re-render fires a pageview while the visitor stays
    // put. Listed one by one it reads as a journey full of repeats and spends the
    // step budget, so a short visit could be reported as a truncated journey.
    const digest = digestSession(
      [pageview(0, "/"), pageview(4, "/"), pageview(9, "/search"), pageview(12, "/search"), pageview(30, "/pricing")],
      { endTimestamp: at(40) }
    );
    expect(digest.steps).toEqual([
      { path: "/", at: 0, dwell: 9, views: 2 },
      { path: "/search", at: 9, dwell: 21, views: 2 },
      { path: "/pricing", at: 30, dwell: 10, views: 1 },
    ]);
    // The pageviews are still counted in the totals; only the journey is collapsed.
    expect(digest.totals.pageviews).toBe(5);
  });

  it("keeps a revisit that came after a different page", () => {
    const digest = digestSession([pageview(0, "/"), pageview(10, "/pricing"), pageview(20, "/")], { endTimestamp: at(30) });
    expect(digest.steps.map(step => step.path)).toEqual(["/", "/pricing", "/"]);
  });

  it("does not call a short journey truncated just because it re-rendered a lot", () => {
    // One page re-rendering thirty times, then another. Real navigation is rare
    // here, so this is a two-visit journey, not a sixty-step one.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => pageview(i, "/")),
      ...Array.from({ length: 30 }, (_, i) => pageview(30 + i, "/pricing")),
    ];
    const digest = digestSession(rows, { endTimestamp: at(60) });
    expect(digest.steps).toHaveLength(2);
    expect(digest.steps[0]).toEqual({ path: "/", at: 0, dwell: 30, views: 30 });
    expect(digest.truncated).toBe(false);
  });

  it("groups repeated clicks on one control instead of repeating the row", () => {
    const digest = digestSession([
      pageview(0, "/pricing"),
      click(2, "/pricing", "Add to cart"),
      click(4, "/pricing", "Add to cart"),
      click(6, "/pricing", "Add to cart"),
      click(9, "/pricing", "Compare"),
    ]);
    const cart = digest.clicks.find(entry => entry.label === "Add to cart");
    expect(cart?.count).toBe(3);
    expect(digest.clicks).toHaveLength(2);
  });

  it("calls a click dead when the visitor went nowhere afterwards", () => {
    const digest = digestSession([
      pageview(0, "/pricing"),
      click(2, "/pricing", "Add to cart"),
      click(5, "/pricing", "Add to cart"),
      click(30, "/pricing", "Checkout"),
      pageview(31, "/checkout"),
    ]);
    const dead = digest.deadClicks.find(entry => entry.label === "Add to cart");
    expect(dead?.count).toBe(2);
    // The one that was followed by a navigation is not dead.
    expect(digest.deadClicks.some(entry => entry.label === "Checkout")).toBe(false);
  });

  it("names the fields a visitor touched without recording what they put in them", () => {
    const digest = digestSession([pageview(0, "/checkout"), input(3, "/checkout", "email"), input(6, "/checkout", "postcode")]);
    // Equal counts keep the order they were touched in, which is the useful one.
    expect(digest.fields.map(field => field.name)).toEqual(["email", "postcode"]);
    expect(digest.fields.map(field => field.kind)).toEqual(["text", "text"]);
    const form = digest.forms.find(entry => entry.name === "checkout");
    expect(form?.fields).toEqual(["email", "postcode"]);
    expect(form?.submitted).toBe(false);
  });

  it("marks a form submitted once one submit event exists", () => {
    const digest = digestSession([pageview(0, "/checkout"), input(3, "/checkout", "email"), submit(9, "/checkout", "checkout")]);
    expect(digest.forms[0].submitted).toBe(true);
    expect(digest.totals.formSubmits).toBe(1);
  });

  it("keeps copied content out of the digest, and only its length", () => {
    const secret = "my password is hunter2";
    const digest = digestSession([
      pageview(0, "/"),
      { timestamp: at(4), type: "copy", pathname: "/", props: { text: secret, textLength: secret.length, sourceElement: "body" } },
    ]);
    const rendered = JSON.stringify(digestForModel(digest, "s1"));
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain(secret);
    // The length is the point: "they copied 21 characters" is a usable signal.
    expect(ALLOWED_PROPS.copy).toContain("textLength");
    expect(ALLOWED_PROPS.copy).not.toContain("text");
  });

  it("reads no prop outside the per-type allowlist", () => {
    const digest = digestSession([
      pageview(0, "/"),
      click(2, "/", "Buy"),
      { timestamp: at(3), type: "custom_event", event_name: "purchase", props: { email: "visitor@example.com", revenue: "99" } },
    ]);
    const rendered = JSON.stringify(digestForModel(digest, "s1"));
    expect(rendered).not.toContain("visitor@example.com");
    // The event name is tracked separately from its props, and that is kept.
    expect(digest.customEvents).toEqual([{ name: "purchase", count: 1 }]);
  });

  it("strips control characters and caps a label, so it cannot smuggle a page", () => {
    const nasty = "Buy\x00 now ‮evil‬ " + "x".repeat(400);
    const digest = digestSession([pageview(0, "/"), click(2, "/", nasty)]);
    const label = digest.clicks[0].label;
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label).not.toContain("\x00");
    expect(label).not.toContain("\u202e");
  });

  it("reports what an error said, not just what kind it was, and never its stack", () => {
    const digest = digestSession([
      pageview(0, "/pricing"),
      {
        timestamp: at(3),
        type: "error",
        event_name: "TypeError",
        pathname: "/pricing",
        props: {
          message: "Failed to fetch",
          type: "unhandledrejection",
          stack: "TypeError: Failed to fetch\n    at chrome-extension://abcdef/inject.js:1:3159",
        },
      },
    ]);
    expect(digest.errors).toEqual([{ message: "Failed to fetch", kind: "unhandledrejection", at: 3 }]);
    const rendered = JSON.stringify(digestForModel(digest, "s1"));
    // A stack names the visitor's own extensions and installed software.
    expect(rendered).not.toContain("chrome-extension");
  });

  it("reads an unlabelled click rather than dropping it", () => {
    const digest = digestSession([pageview(0, "/"), { timestamp: at(2), type: "button_click", pathname: "/", props: {} }]);
    expect(digest.clicks[0].label).toBe("(unlabelled)");
  });

  it("gives the last page a dwell time when the session end is known", () => {
    const digest = digestSession([pageview(0, "/"), pageview(10, "/pricing")], { endTimestamp: at(40) });
    expect(digest.steps[1].dwell).toBe(30);
  });

  it("survives an empty session", () => {
    const digest = digestSession([]);
    expect(digest.steps).toEqual([]);
    expect(digest.durationSeconds).toBe(0);
    expect(digestForModel(digest, "s1").totals.clicks).toBe(0);
  });

  it("stays small on a session with a hundred distinct controls, and admits it was cut", () => {
    const rows: TimelineRow[] = [pageview(0, "/")];
    for (let second = 1; second <= 200; second += 2) {
      rows.push(click(second, "/", `Control ${second}`), input(second + 1, "/", `field_${second}`));
    }
    const digest = digestSession(rows);
    expect(digest.truncated).toBe(true);
    expect(digest.clicks).toHaveLength(20);
    // What matters is that the digest does not grow with the event count: 400
    // events in, a bounded summary out, and the model reads that.
    const rendered = JSON.stringify(digestForModel(digest, "s1"));
    expect(rendered.length).toBeLessThan(4000);
    expect(rows.length).toBeGreaterThan(200);
  });
});

describe("the gate", () => {
  it("refuses, and says where the setting is, when the Site does not record replays", async () => {
    const tool = SESSION_TOOLS.find(entry => entry.name === "get_session_timeline")!;
    const ctx = { sessionReplay: false } as unknown as ToolContext;
    await expect(tool.run({ session_id: "abc" }, ctx)).rejects.toThrow(/Site Settings/);
  });

  it("refuses the comparison too, so it cannot be used as a way in", async () => {
    const tool = SESSION_TOOLS.find(entry => entry.name === "analyse_sessions")!;
    const ctx = { sessionReplay: false } as unknown as ToolContext;
    await expect(tool.run({ session_ids: ["a", "b"] }, ctx)).rejects.toThrow(/Site Settings/);
  });
});

describe("reading a session in a window", () => {
  it("does not alias its output over the column its time clause filters on", () => {
    // Regression, and it was silent. ClickHouse resolves a bare `timestamp` in
    // the time clause to the SELECT alias, so `timestamp <= toTimeZone(now64(3))`
    // became milliseconds compared against a DateTime and matched nothing. Every
    // bounded read came back as "no interaction events" while all_time worked,
    // which read like a range problem rather than a query one.
    const query = buildSessionTimelineQuery("AND timestamp >= toDateTime('2026-07-05')");
    expect(query).toContain("AS event_ts");
    expect(query).not.toMatch(/AS\s+timestamp\b/i);
    expect(query).toContain("timestamp_ms");
  });

  it("defaults to a wide range, because a session id carries no date", () => {
    // Shaped like the real one Ask sends: today's range, with both bounds. An
    // earlier version of this test omitted startDate, so it took the branch that
    // worked and passed while every session in Ask came back empty.
    const ctx = {
      timezone: "UTC",
      defaultRange: { label: "today", startDate: "2026-09-26", endDate: "2026-09-26" },
    } as unknown as ToolContext;
    expect(windowFor({}, ctx).label).toBe("the last 90 days");
  });

  it("uses an explicit range when the model gives one", () => {
    const ctx = { timezone: "UTC", defaultRange: { label: "today" } } as unknown as ToolContext;
    const range = windowFor({ time: { start_date: "2026-09-01", end_date: "2026-09-20" } }, ctx);
    expect(range).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-20" });
  });

  it("accepts a preset, and refuses half a range", () => {
    const ctx = { timezone: "UTC", defaultRange: { label: "today" } } as unknown as ToolContext;
    expect(windowFor({ time: { preset: "last_30_days" } }, ctx).label).toBe("the last 30 days");
    expect(() => windowFor({ time: { start_date: "2026-09-01" } }, ctx)).toThrow(/both/);
  });
});

describe("a session with more events than the reader takes", () => {
  it("says the counts are a floor, because a digest that undercounts is worse than one that admits it is partial", () => {
    const partial: SessionDigest = { ...digestSession([pageview(0, "/")]), eventsTruncated: true, eventCount: 21_000 };
    const rendered = digestForModel(partial, "s1") as Record<string, unknown>;
    expect(rendered.events_truncated).toBe(true);
    expect(String(rendered.note)).toMatch(/floor, not a total/);
  });

  it("warns that an empty list is not an absence, because a truncated read cannot support one", () => {
    // An empty `errors` on a truncated read is ambiguous — the model read it as
    // "no errors in this session" and stated that as fact. The note has to cover
    // what is missing, not only what was counted.
    const partial: SessionDigest = { ...digestSession([pageview(0, "/")]), eventsTruncated: true, eventCount: 21_000 };
    const rendered = digestForModel(partial, "s1") as Record<string, unknown>;
    expect(String(rendered.note)).toMatch(/empty list means none were found/);
    expect(String(rendered.note)).toMatch(/absence as exact/);
  });

  it("says nothing of the sort for a session that was read whole", () => {
    const whole = digestForModel(digestSession([pageview(0, "/")]), "s1") as Record<string, unknown>;
    expect(whole.events_truncated).toBeUndefined();
  });

  it("does not hand the model a list of broken controls", () => {
    // "dead_clicks" read as a defect list: asked what UX problems a session
    // showed, the analyst led with "+10s ×160" as a broken video player, when a
    // seek control acts in place and never navigates. The key no longer asserts
    // a defect, and the caveat travels with the data.
    const rendered = digestForModel(digestSession([pageview(0, "/"), click(1, "/", "+10s")]), "s1") as Record<
      string,
      unknown
    >;
    expect(rendered.dead_clicks).toBeUndefined();
    expect(rendered.clicks_with_no_navigation).toBeDefined();
    expect(String(rendered.clicks_note)).toMatch(/act in place/);
    expect(String(rendered.clicks_note)).toMatch(/never as a control that did not work/);
  });
});

describe("a session that browses for hours", () => {
  /** 2,000 pageviews is a real two-hour session on a content site. */
  const longSession = (): TimelineRow[] =>
    Array.from({ length: 2_000 }, (_, index) => pageview(index * 3, `/watch/video-number-${index}`));

  it("keeps the first and last pages and says the middle is not shown", () => {
    const digest = digestSession(longSession());
    expect(digest.steps).toHaveLength(40);
    expect(digest.steps[0].path).toBe("/watch/video-number-0");
    expect(digest.steps[39].path).toBe("/watch/video-number-1999");
    expect(digest.stepsTruncated).toBe(true);
    expect(digest.truncated).toBe(true);
  });

  it("still reports the real entry and exit page, from the whole journey", () => {
    const digest = digestSession(longSession());
    expect(digest.entryPage).toBe("/watch/video-number-0");
    expect(digest.exitPage).toBe("/watch/video-number-1999");
  });

  it("fits in a tool result the agent will actually pass on", () => {
    // The agent drops tool output past 24,000 characters, replacing it with a
    // placeholder — so a digest over that reads to the model as "no data". This is
    // the size guard that stops a long session looking like a missing one.
    const digest = digestSession([...longSession(), ...Array.from({ length: 500 }, (_, i) => click(i * 2, "/x", `Control ${i}`))]);
    const rendered = JSON.stringify(digestForModel(digest, "s1"));
    expect(rendered.length).toBeLessThan(20_000);
    expect(String((digestForModel(digest, "s1") as Record<string, unknown>).journey_note)).toMatch(/first and last/);
  });
});

describe("finding sessions by what the visitor did", () => {
  it("accepts a filter in the dashboard's shape", () => {
    const parsed = validateFilters(
      JSON.stringify([{ parameter: "pathname", type: "equals", value: ["/pricing"] }])
    );
    expect(parsed).toEqual([{ parameter: "pathname", type: "equals", value: ["/pricing"] }]);
  });

  it("refuses a parameter that is not one of the dashboard's", () => {
    expect(() => validateFilters(JSON.stringify([{ parameter: "sql_injection", type: "equals", value: ["x"] }]))).toThrow();
  });

  it("refuses a comparison type that does not exist", () => {
    expect(() => validateFilters(JSON.stringify([{ parameter: "pathname", type: "sounds_like", value: ["x"] }]))).toThrow();
  });
});

describe("what a session search hands the model", () => {
  it("carries the session id, which is the one field that makes it usable", () => {
    // The service returns ClickHouse column names. Reading camelCase here gave
    // undefined, JSON.stringify dropped it, and the model got rows it could not
    // follow — a search that found sessions it could not then read.
    const row = {
      session_id: "abc123",
      start_time: "2026-09-22 20:21:32",
      duration_ms: 4210,
      page_url: "https://example.com/watch/1",
      country: "DE",
      browser: "Chrome",
      device_type: "desktop",
    };
    const shaped = JSON.parse(
      JSON.stringify({
        sessions: [{ session_id: row.session_id, duration_seconds: row.duration_ms, entry_page: row.page_url }],
      })
    );
    expect(shaped.sessions[0].session_id).toBe("abc123");
    expect(shaped.sessions[0].duration_seconds).toBe(4210);
  });
});
