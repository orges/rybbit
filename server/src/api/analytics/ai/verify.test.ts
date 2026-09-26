import { describe, expect, it } from "vitest";
import { unsupportedFigures } from "./verify.js";

const overview = JSON.stringify({
  range: "the last 7 days",
  metrics: [
    { metric: "Sessions", value: 19048, unit: "count" },
    { metric: "Pageviews", value: 163766, unit: "count" },
    { metric: "Bounce rate", value: 34.5, unit: "percent" },
  ],
});

describe("unsupportedFigures", () => {
  it("accepts a figure that is in the tool output", () => {
    expect(unsupportedFigures("Sessions were 19,048 with a bounce rate of 34.5%.", [overview])).toEqual([]);
  });

  it("flags a figure the tools never returned, as the answer wrote it", () => {
    expect(unsupportedFigures("Sessions were 19,048 and users were 21,904.", [overview])).toEqual(["21,904"]);
  });

  it("accepts a figure quoted to the nearest hundred", () => {
    expect(unsupportedFigures("Pageviews were about 163,800, and 163,766 exactly.", [overview])).toEqual([]);
  });

  it("leaves a small abbreviated figure alone rather than guessing", () => {
    // "164k" is not a quoted measurement, so there is nothing to check.
    expect(unsupportedFigures("Pageviews were about 164k.", [overview])).toEqual([]);
  });

  it("ignores the model's own arithmetic on small numbers", () => {
    expect(unsupportedFigures("The top page had 65% more views than the runner-up, one of the top 3.", [overview])).toEqual([]);
  });

  it("does not treat a date or a clock time as a measurement", () => {
    expect(unsupportedFigures("Between 2026-09-18 and 2026-09-25, at 14:30, nothing changed.", [overview])).toEqual([]);
  });

  it("does not treat a year written in prose as a measurement", () => {
    expect(unsupportedFigures("On September 25, 2026 there were 19,048 sessions.", [overview])).toEqual([]);
    // Separated by a thousands mark it is a count, and is checked.
    expect(unsupportedFigures("Sessions were 2,026 on September 25.", [overview])).toEqual(["2,026"]);
  });

  it("reports each unsupported figure once, in the order it appears", () => {
    expect(unsupportedFigures("First 71,001 then 55,555 and 71,001 again.", [overview])).toEqual(["71,001", "55,555"]);
  });

  it("accepts a figure the reader can see quoted from an earlier turn", () => {
    // The model's context holds the whole thread, so a number it is repeating
    // back is supported even though this turn's tools never said it.
    const thread = ["Last week had 19,048 sessions."];
    expect(unsupportedFigures("As I said, 19,048 sessions last week; 20,501 this week.", [overview, ...thread])).toEqual([
      "20,501",
    ]);
  });

  it("has nothing to check when the answer is empty, and flags everything when no tool ran", () => {
    expect(unsupportedFigures("", [overview])).toEqual([]);
    expect(unsupportedFigures("Traffic is down.", [])).toEqual([]);
    expect(unsupportedFigures("Sessions were 19,048.", [])).toEqual(["19,048"]);
  });
});

describe("figures inside JSON arrays", () => {
  // Tool output is mostly JSON, so almost every figure a tool returns follows a
  // comma. Reading the separator as part of the number filed 21.99 as 10021.99 and
  // flagged the model's correctly rounded 22.0% as invented.
  const retention = JSON.stringify({
    cohorts: [
      { cohort: "2026-09-21", size: 6280, retained_percent: [100, null, null] },
      { cohort: "2026-09-14", size: 25322, retained_percent: [100, 3.07, null] },
      { cohort: "2026-09-07", size: 1296, retained_percent: [100, 21.99, 9.03] },
    ],
  });

  it("recognises every element of an array, not only the last", () => {
    expect(unsupportedFigures("cohorts of **6,280**, **25,322** and **1,296** users", [retention])).toEqual([]);
  });

  it("accepts a figure the model rounded to the precision it chose", () => {
    // 21.99 quoted as 22.0 is rounding, not fabrication.
    expect(unsupportedFigures("retained **22.0%** then **9.0%**", [retention])).toEqual([]);
    expect(unsupportedFigures("retained **3.1%**", [retention])).toEqual([]);
  });

  it("still catches a figure no array element supports", () => {
    expect(unsupportedFigures("retained **41.7%**", [retention])).toEqual(["41.7%"]);
    expect(unsupportedFigures("**77,100** users", [retention])).toEqual(["77,100"]);
  });

  it("keeps a thousands separator inside a number", () => {
    expect(unsupportedFigures("**1,296** users", [retention])).toEqual([]);
  });
});
