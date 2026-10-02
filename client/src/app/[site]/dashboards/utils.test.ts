import { describe, expect, it } from "vitest";
import { inferChartBucket } from "./utils";

describe("inferChartBucket", () => {
  it("reads a day out of date-only labels", () => {
    expect(inferChartBucket(["2026-09-12", "2026-09-19", "2026-09-25"])).toBe("day");
  });

  it("reads sub-hour buckets", () => {
    expect(inferChartBucket(["2026-09-25 10:00:00", "2026-09-25 10:05:00", "2026-09-25 10:10:00"])).toBe("five_minutes");
    expect(inferChartBucket(["2026-09-25 10:00:00", "2026-09-25 10:15:00", "2026-09-25 10:30:00"])).toBe("fifteen_minutes");
  });

  it("reads an hour out of hourly points, whatever the range", () => {
    expect(inferChartBucket(["2026-09-25 00:00:00", "2026-09-25 01:00:00", "2026-09-25 02:00:00"])).toBe("hour");
  });

  it("reads a day out of points a day apart", () => {
    expect(inferChartBucket(["2026-09-19 00:00:00", "2026-09-20 00:00:00", "2026-09-21 00:00:00"])).toBe("day");
  });

  it("reads a week out of points a week apart, and a month out of quarterly ones", () => {
    expect(inferChartBucket(["2026-01-05 00:00:00", "2026-01-12 00:00:00", "2026-01-19 00:00:00"])).toBe("week");
    expect(inferChartBucket(["2026-01-05 00:00:00", "2026-04-05 00:00:00", "2026-07-05 00:00:00"])).toBe("month");
    expect(inferChartBucket(["2025-01-05 00:00:00", "2026-01-05 00:00:00"])).toBe("year");
  });

  it("falls back to a day for unparseable labels", () => {
    expect(inferChartBucket(["/pricing", "/docs", "/"])).toBe("day");
    expect(inferChartBucket([])).toBe("day");
  });
});
