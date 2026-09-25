import { describe, expect, it } from "vitest";
import { describeInput } from "./ToolActivity";

describe("describeInput", () => {
  it("says what the reader asked for, not the model's column names", () => {
    expect(describeInput({ dimension: "pathname", limit: 6 })).toBe("by pathname · top 6");
  });

  it("leaves the plumbing out of a row", () => {
    expect(
      describeInput({
        result_id: "r1",
        title: "Top 6 pages",
        error_message: "Failed to fetch",
        dimension: "pathname",
      })
    ).toBe("by pathname");
  });

  it("reads a range the way it is said", () => {
    expect(describeInput({ time: { preset: "last_7_days" } })).toBe("last 7 days");
    expect(describeInput({ time: { start_date: "2026-09-19", end_date: "2026-09-25" } })).toBe("2026-09-19 to 2026-09-25");
  });

  it("counts a funnel's steps instead of printing them", () => {
    expect(describeInput({ steps: [{ type: "page", value: "/" }, { type: "event", value: "signup" }] })).toBe("2 steps");
  });

  it("has nothing to say about a tool called with no arguments", () => {
    expect(describeInput({})).toBe("");
    expect(describeInput(undefined)).toBe("");
  });
});
