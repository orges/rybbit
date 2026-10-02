import { describe, expect, it } from "vitest";
import { asUtcIso, resultLink } from "./links";

describe("resultLink", () => {
  it("sends each tool to the page that owns its data", () => {
    expect(resultLink("get_errors", {}, 7)).toEqual({ href: "/7/errors", label: "Errors" });
    expect(resultLink("get_funnel", {}, 7)).toEqual({ href: "/7/funnels", label: "Funnels" });
    expect(resultLink("search_replays", {}, 7)).toEqual({ href: "/7/replay", label: "Replay" });
    expect(resultLink("get_retention", {}, 7)).toEqual({ href: "/7/retention", label: "Retention" });
  });

  it("routes a breakdown to the page for the dimension it broke down", () => {
    expect(resultLink("get_breakdown", { dimension: "pathname" }, 7)).toEqual({ href: "/7/pages", label: "Pages" });
    expect(resultLink("get_breakdown", { dimension: "event_name" }, 7)).toEqual({ href: "/7/events", label: "Events" });
    expect(resultLink("get_breakdown", { dimension: "country" }, 7)).toEqual({ href: "/7/globe", label: "Globe" });
  });

  it("falls back to the dashboard for a breakdown with no page of its own", () => {
    expect(resultLink("get_breakdown", { dimension: "browser" }, 7)).toEqual({ href: "/7/main", label: "Dashboard" });
    expect(resultLink("get_breakdown", {}, 7)).toEqual({ href: "/7/main", label: "Dashboard" });
  });

  it("has no link for a tool that is not about the site's data", () => {
    expect(resultLink("show_chart", {}, 7)).toBeNull();
    expect(resultLink("suggest_followups", {}, 7)).toBeNull();
  });
});

describe("asUtcIso", () => {
  it("marks a bare wall-clock timestamp as UTC rather than local time", () => {
    expect(asUtcIso("2026-09-20 22:35:18")).toBe("2026-09-20T22:35:18Z");
    expect(asUtcIso("2026-09-20 22:32:53.913")).toBe("2026-09-20T22:32:53.913Z");
  });

  it("leaves a value that already carries an offset alone", () => {
    expect(asUtcIso("2026-09-20T22:35:18.000Z")).toBe("2026-09-20T22:35:18.000Z");
    expect(asUtcIso("2026-09-20T22:35:18+02:00")).toBe("2026-09-20T22:35:18+02:00");
    expect(asUtcIso("")).toBe("");
  });
});
