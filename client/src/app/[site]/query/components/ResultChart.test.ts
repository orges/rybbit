import { expect, it } from "vitest";
import { chartData, chartLabel } from "./ResultChart";

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
