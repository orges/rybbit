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

  it("has nothing to check when the answer is empty, and flags everything when no tool ran", () => {
    expect(unsupportedFigures("", [overview])).toEqual([]);
    expect(unsupportedFigures("Traffic is down.", [])).toEqual([]);
    expect(unsupportedFigures("Sessions were 19,048.", [])).toEqual(["19,048"]);
  });
});
