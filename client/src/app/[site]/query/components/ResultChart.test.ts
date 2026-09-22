import { expect, it } from "vitest";
import { chartData, chartLabel, overviewTable } from "./ResultChart";

it("makes comparison column names readable", () => {
  expect(chartLabel("sessions_3_days_ago")).toBe("Sessions 3 days ago");
  expect(chartLabel("pageviews_4_days_ago")).toBe("Pageviews 4 days ago");
});

it("charts a single overview row as metrics", () => {
  expect(chartData([{ sessions: 5242, pageviews: 44676, events: 175045 }])).toEqual({
    label: "Metric",
    metrics: ["Value"],
    points: [
      { label: "sessions", Value: 5242 },
      { label: "pageviews", Value: 44676 },
      { label: "events", Value: 175045 },
    ],
  });
});

it("charts multiple numeric series against a date", () => {
  expect(
    chartData([
      { day: "2026-09-19", sessions: 5, events: 9 },
      { day: "2026-09-20", sessions: 8, events: 12 },
    ])
  ).toEqual({
    label: "day",
    metrics: ["sessions", "events"],
    points: [
      { label: "2026-09-19", sessions: 5, events: 9 },
      { label: "2026-09-20", sessions: 8, events: 12 },
    ],
  });
});

it("does not chart multi-dimensional or duplicate-label breakdowns", () => {
  expect(
    chartData([
      { type: "pageview", event_name: "", pathname: "/search", events: 12 },
      { type: "pageview", event_name: "", pathname: "/home", events: 8 },
    ])
  ).toBeNull();
  expect(
    chartData([
      { type: "pageview", events: 12 },
      { type: "pageview", events: 8 },
    ])
  ).toBeNull();
});

it("pivots one-row comparisons into a table by metric and period", () => {
  const data = chartData([
    {
      sessions_3_days_ago: 5242,
      sessions_4_days_ago: 5100,
      events_3_days_ago: 175045,
      events_4_days_ago: 160300,
    },
  ]);
  expect(overviewTable(data!.points)).toEqual({
    columns: ["3 days ago", "4 days ago"],
    rows: [
      { label: "Sessions", values: [5242, 5100] },
      { label: "Events", values: [175045, 160300] },
    ],
  });
});
