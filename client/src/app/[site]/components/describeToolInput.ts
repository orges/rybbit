/**
 * What a tool was asked, in words rather than keys.
 *
 * Two places need it and neither should own it: the Ask tool trail, which used to
 * lead with the model's own JSON, and the page copilots, which show what a
 * proposal was based on. A reader wants to know a breakdown was *by pathname*, not
 * that the result had `columns: cohort_period, period_difference…`.
 */

/** Arguments a reader never needs to see. */
const HIDDEN_ARGS = new Set(["result_id", "title", "sql", "error_message", "options"]);

export function describeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (HIDDEN_ARGS.has(key) || value === undefined || value === null || value === "") continue;
    if (key === "time" || key === "range") {
      const range = describeRange(value);
      if (range) parts.push(range);
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) continue;
      // A filter is {parameter, type, value}, and String() on one of those is
      // "[object Object]" — which tells a reader nothing about what was searched.
      if (value.every(entry => entry && typeof entry === "object" && "parameter" in entry)) {
        const described = (value as Array<Record<string, unknown>>)
          .map(entry => `${String(entry.parameter)} ${String(entry.type).replace(/_/g, " ")} ${(entry.value as unknown[] | undefined)?.map(String).join(", ") ?? ""}`.trim())
          .join("; ");
        parts.push(described);
        continue;
      }
      parts.push(key === "steps" ? `${value.length} steps` : `${key}: ${value.map(String).join(", ")}`);
      continue;
    }
    if (typeof value === "object") continue;
    if (key === "dimension") parts.push(`by ${String(value)}`);
    else if (key === "limit") parts.push(`top ${String(value)}`);
    else if (key === "mode") parts.push(String(value) === "week" ? "weekly" : "daily");
    else if (key === "range_days") parts.push(`last ${String(value)} days`);
    else parts.push(`${key}: ${String(value)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

function describeRange(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const range = value as { preset?: string; start_date?: string; end_date?: string };
  if (range.preset) return String(range.preset).replace(/_/g, " ");
  if (range.start_date && range.end_date) return `${range.start_date} to ${range.end_date}`;
  return "";
}

