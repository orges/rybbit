import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";

// Only the presentation half of the registry is exercised here. Stubbing the
// analytics tools keeps this file off the ClickHouse, storage and auth chain
// they pull in, which needs a live base URL just to import.
vi.mock("./tools.js", () => ({ ANALYST_TOOLS: [] }));

import { defaultBucket, previousRange, resolvePreset, resolveToolRange } from "./time.js";
import { ALL_TOOLS, ResultStore } from "./presentation.js";
import type { ToolContext, ToolRow } from "./tools.js";

const context = (results: ResultStore) =>
  ({
    siteId: 1,
    siteIds: [1],
    timezone: "UTC",
    defaultRange: resolvePreset("last_7_days", "UTC"),
    filters: [],
    results,
    signal: new AbortController().signal,
  }) as ToolContext;

const run = async (name: string, args: Record<string, unknown>, results: ResultStore) => {
  const tool = ALL_TOOLS.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.run(args, context(results));
};

const storeWith = (rows: ToolRow[]) => {
  const store = new ResultStore();
  const stored = store.add(rows, "get_breakdown");
  return { store, resultId: stored?.id ?? "" };
};

describe("time presets", () => {
  it("resolves a preset to an inclusive day range in the site's timezone", () => {
    const range = resolvePreset("yesterday", "Europe/Berlin", DateTime.fromISO("2026-09-25T10:00:00Z"));
    expect(range).toEqual({ startDate: "2026-09-24", endDate: "2026-09-24", label: "yesterday" });
  });

  it("keeps a bounded previous period the same length as the current one", () => {
    const range = { startDate: "2026-09-19", endDate: "2026-09-21", label: "3 days" };
    expect(previousRange(range, "UTC")).toEqual({
      startDate: "2026-09-16",
      endDate: "2026-09-18",
      label: "the previous 3 days",
    });
  });

  it("has no previous period for an all-time range", () => {
    expect(previousRange({ label: "all time" }, "UTC")).toBeUndefined();
  });

  it("falls back to the dashboard range when the model names no time", () => {
    const dashboard = resolvePreset("today", "UTC");
    expect(resolveToolRange(undefined, dashboard, "UTC")).toEqual(dashboard);
  });

  it("prefers an explicit request over the dashboard range", () => {
    const dashboard = resolvePreset("today", "UTC");
    const resolved = resolveToolRange({ preset: "last_30_days" }, dashboard, "UTC");
    expect(resolved.label).toBe("the last 30 days");
  });

  it("picks a bucket that keeps the trend readable", () => {
    expect(defaultBucket({ startDate: "2026-09-25", endDate: "2026-09-25", label: "" })).toBe("hour");
    expect(defaultBucket({ startDate: "2026-09-01", endDate: "2026-09-25", label: "" })).toBe("day");
    expect(defaultBucket({ startDate: "2026-01-01", endDate: "2026-09-25", label: "" })).toBe("week");
  });
});

describe("show_chart", () => {
  it("charts a stored result", async () => {
    const { store, resultId } = storeWith([
      { value: "/", count: 10 },
      { value: "/pricing", count: 4 },
    ]);
    const output = await run("show_chart", { result_id: resultId, title: "Top pages", type: "bar", dimension: "value", metric: "count" }, store);
    expect(output.artifact).toEqual({
      type: "chart",
      title: "Top pages",
      chartType: "bar",
      dimension: "value",
      metric: "count",
      points: [
        { label: "/", value: 10 },
        { label: "/pricing", value: 4 },
      ],
    });
  });

  it("refuses a column the result does not have, and lists the ones it does", async () => {
    const { store, resultId } = storeWith([{ value: "/", count: 10 }]);
    await expect(
      run("show_chart", { result_id: resultId, title: "x", type: "bar", dimension: "page", metric: "count" }, store)
    ).rejects.toThrow('Column "page" is not in r1. Available columns: value, count');
  });

  it("refuses to chart a column with duplicate labels", async () => {
    const { store, resultId } = storeWith([
      { value: "/", count: 10 },
      { value: "/", count: 4 },
    ]);
    await expect(
      run("show_chart", { result_id: resultId, title: "x", type: "bar", dimension: "value", metric: "count" }, store)
    ).rejects.toThrow("distinct");
  });

  it("refuses a non-numeric metric instead of charting zeroes", async () => {
    const { store, resultId } = storeWith([
      { value: "/", count: 10, label: null },
      { value: "/pricing", count: 4, label: "n/a" },
    ]);
    await expect(
      run("show_chart", { result_id: resultId, title: "x", type: "bar", dimension: "value", metric: "label" }, store)
    ).rejects.toThrow('Column "label" must hold numbers');
  });

  it("allows series on a line chart but not on a bar chart", async () => {
    const rows = [
      { day: "2026-09-19", country: "DE", views: 3 },
      { day: "2026-09-19", country: "US", views: 5 },
      { day: "2026-09-20", country: "DE", views: 4 },
      { day: "2026-09-20", country: "US", views: 2 },
    ];
    const { store, resultId } = storeWith(rows);
    const line = await run(
      "show_chart",
      { result_id: resultId, title: "By country", type: "line", dimension: "day", metric: "views", series: "country" },
      store
    );
    expect(line.artifact).toMatchObject({ type: "chart", chartType: "line" });
    await expect(
      run("show_chart", { result_id: resultId, title: "x", type: "bar", dimension: "day", metric: "views", series: "country" }, store)
    ).rejects.toThrow("series");
  });
});

describe("show_table", () => {
  it("renders the requested columns and reports what it left out", async () => {
    const { store, resultId } = storeWith([
      { value: "/", count: 10, pageviews: 12 },
      { value: "/pricing", count: 4, pageviews: 5 },
      { value: "/docs", count: 2, pageviews: 3 },
    ]);
    const output = await run("show_table", { result_id: resultId, title: "Top pages", columns: ["value", "count"], limit: 2 }, store);
    expect(output.artifact).toMatchObject({
      type: "table",
      columns: ["value", "count"],
      rows: [
        ["/", "10"],
        ["/pricing", "4"],
      ],
      total: 3,
      truncated: true,
    });
  });

  it("sorts numerically when asked", async () => {
    const { store, resultId } = storeWith([
      { value: "/", count: 10 },
      { value: "/pricing", count: 40 },
    ]);
    const output = await run("show_table", { result_id: resultId, title: "x", sort_by: "count", sort_order: "asc" }, store);
    expect(output.artifact).toMatchObject({ rows: [["/", "10"], ["/pricing", "40"]] });
  });

  it("rejects an unknown result id", async () => {
    const { store } = storeWith([{ value: "/", count: 1 }]);
    await expect(run("show_table", { result_id: "r9", title: "x" }, store)).rejects.toThrow("No result r9");
  });
});
