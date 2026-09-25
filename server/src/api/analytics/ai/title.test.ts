import { describe, expect, it } from "vitest";
import { deriveTitle } from "./title.js";

describe("deriveTitle", () => {
  it("strips the opening filler and keeps the question readable", () => {
    expect(deriveTitle("hey can you show me the top pages by bounce rate?")).toBe("Top pages by bounce rate");
    expect(deriveTitle("What are the top custom events today?")).toBe("Top custom events today");
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
