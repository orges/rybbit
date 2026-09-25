import { describe, expect, it } from "vitest";
import { deriveTitle } from "./title.js";

describe("deriveTitle", () => {
  it("strips the opening filler and keeps the question readable", () => {
    expect(deriveTitle("hey can you show me the top pages by bounce rate?")).toBe("Top pages by bounce rate");
    expect(deriveTitle("What are the top custom events today?")).toBe("Top custom events today");
  });

  it("names the thread after the data, not the request to draw it", () => {
    expect(deriveTitle("Draw a line chart of daily sessions over the last 7 days")).toBe(
      "Daily sessions over the last 7 days"
    );
    expect(deriveTitle("plot a bar chart for the top 10 pages")).toBe("Top 10 pages");
    expect(deriveTitle("Chart weekly users by country")).toBe("Weekly users by country");
  });

  it("leaves a chart asked for as a subject alone", () => {
    expect(deriveTitle("Chart of daily sessions by channel")).toBe("Chart of daily sessions by channel");
  });

  it("keeps a long question to a scannable length", () => {
    const title = deriveTitle(
      "compare sessions, pageviews, users, bounce rate and average session duration between this week and the previous one"
    );
    expect(title.split(/\s+/).length).toBeLessThanOrEqual(7);
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it("never returns an empty title", () => {
    expect(deriveTitle("hi").length).toBeGreaterThan(0);
  });
});
