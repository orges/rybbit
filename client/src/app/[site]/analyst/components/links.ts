/**
 * Where a result came from, in the product.
 *
 * A chart of a breakdown and a chart of a funnel are the same picture, but only
 * one of them is a place you can keep working: the page that owns the data. Every
 * tool gets a page here, so a rendered result is one click from the real thing —
 * with the Site's own filters, not a dead end.
 */
const TOOL_PAGES: Record<string, { route: string; label: string }> = {
  get_overview: { route: "main", label: "Dashboard" },
  get_timeseries: { route: "main", label: "Dashboard" },
  get_breakdown: { route: "main", label: "Dashboard" },
  list_event_names: { route: "events", label: "Events" },
  get_event_properties: { route: "events", label: "Events" },
  get_errors: { route: "errors", label: "Errors" },
  get_web_vitals: { route: "performance", label: "Performance" },
  get_retention: { route: "retention", label: "Retention" },
  get_funnel: { route: "funnels", label: "Funnels" },
  get_journeys: { route: "journeys", label: "Journeys" },
  search_replays: { route: "replay", label: "Replay" },
  run_sql: { route: "query", label: "Query" },
};

/** A breakdown of pages belongs on Pages, not on the dashboard. */
const BREAKDOWN_PAGES: Array<{ dimension: string; route: string; label: string }> = [
  { dimension: "pathname", route: "pages", label: "Pages" },
  { dimension: "page_title", route: "pages", label: "Pages" },
  { dimension: "event_name", route: "events", label: "Events" },
  { dimension: "entry_page", route: "pages", label: "Pages" },
  { dimension: "exit_page", route: "pages", label: "Pages" },
  { dimension: "country", route: "globe", label: "Globe" },
  { dimension: "city", route: "globe", label: "Globe" },
  { dimension: "region", route: "globe", label: "Globe" },
  { dimension: "channel", route: "main", label: "Dashboard" },
];

export type ResultLink = { href: string; label: string } | null;

export function resultLink(
  toolName: string,
  input: unknown,
  siteId: number
): { href: string; label: string } | null {
  const page = TOOL_PAGES[toolName];
  if (!page) return null;
  if (toolName === "get_breakdown") {
    const dimension = (input as { dimension?: string } | undefined)?.dimension;
    const match = BREAKDOWN_PAGES.find(entry => entry.dimension === dimension);
    if (match) return { href: `/${siteId}/${match.route}`, label: match.label };
  }
  return { href: `/${siteId}/${page.route}`, label: page.label };
}

/** A session id in a result is a link to that recording. */
export const SESSION_COLUMN = "session_id";
