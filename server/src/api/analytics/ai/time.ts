import { DateTime } from "luxon";
import { getTimeStatement } from "../utils/timeWindow.js";

/**
 * Relative time ranges the analyst can resolve itself.
 *
 * The model must never write date bounds into SQL. "Today", "last week" and
 * "yesterday" are the words people actually use, and a model that has to
 * translate them into `toDate(now())` gets it wrong often enough to be
 * dangerous — an unbounded query answers "which video got the most views today"
 * with all-time totals. Presets are resolved here, on the server, where the
 * clock and the timezone are known.
 */
export const TIME_PRESETS = [
  "today",
  "yesterday",
  "last_24_hours",
  "last_7_days",
  "last_14_days",
  "last_30_days",
  "last_90_days",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "all_time",
] as const;

export type TimePreset = (typeof TIME_PRESETS)[number];

/** A concrete, inclusive day range in the site's timezone. */
export interface ResolvedRange {
  startDate?: string;
  endDate?: string;
  label: string;
}

const presetLabels: Record<TimePreset, string> = {
  today: "today",
  yesterday: "yesterday",
  last_24_hours: "the last 24 hours",
  last_7_days: "the last 7 days",
  last_14_days: "the last 14 days",
  last_30_days: "the last 30 days",
  last_90_days: "the last 90 days",
  this_week: "this week",
  last_week: "last week",
  this_month: "this month",
  last_month: "last month",
  all_time: "all time",
};

export function isTimePreset(value: unknown): value is TimePreset {
  return TIME_PRESETS.includes(value as TimePreset);
}

/**
 * Resolves a preset against the current time in `timezone`, returning the
 * inclusive `start_date`/`end_date` pair the ClickHouse builders expect.
 */
export function resolvePreset(preset: TimePreset, timezone: string, now: DateTime<boolean> = DateTime.now()): ResolvedRange {
  const local = now.setZone(timezone);
  const iso = (value: DateTime) => value.toFormat("yyyy-MM-dd");
  const shift = (days: number) => local.minus({ days }).startOf("day");
  const range = (start: DateTime, end: DateTime): ResolvedRange => ({
    startDate: iso(start),
    endDate: iso(end),
    label: presetLabels[preset],
  });
  switch (preset) {
    case "today":
      return range(local, local);
    case "yesterday": {
      const day = shift(1);
      return range(day, day);
    }
    case "last_24_hours":
      return { startDate: iso(local.minus({ hours: 24 })), endDate: iso(local), label: presetLabels[preset] };
    case "last_7_days":
      return range(shift(6), local);
    case "last_14_days":
      return range(shift(13), local);
    case "last_30_days":
      return range(shift(29), local);
    case "last_90_days":
      return range(shift(89), local);
    case "this_week":
      return range(local.startOf("week"), local);
    case "last_week": {
      const start = local.minus({ weeks: 1 }).startOf("week");
      return range(start, start.plus({ days: 6 }));
    }
    case "this_month":
      return range(local.startOf("month"), local);
    case "last_month": {
      const start = local.minus({ months: 1 }).startOf("month");
      return range(start, start.endOf("month"));
    }
    case "all_time":
      return { label: presetLabels.all_time };
  }
}

/**
 * The window a tool call runs over: an explicit request when the model gave one,
 * otherwise the range the user is currently looking at in the dashboard.
 */
export function resolveToolRange(
  requested: { preset?: string; start_date?: string; end_date?: string } | undefined,
  fallback: ResolvedRange,
  timezone: string
): ResolvedRange {
  if (requested?.start_date || requested?.end_date) {
    return {
      startDate: requested.start_date,
      endDate: requested.end_date,
      label: [requested.start_date, requested.end_date].filter(Boolean).join(" to ") || fallback.label,
    };
  }
  if (requested?.preset && isTimePreset(requested.preset)) return resolvePreset(requested.preset, timezone);
  return fallback;
}

/**
 * Same-length window immediately before `range`, for the "up or down from last
 * period" comparisons the analyst answers with. A previous period of a different
 * length makes every percentage change look better or worse than it was.
 */
export function previousRange(range: ResolvedRange, timezone: string, now: DateTime<boolean> = DateTime.now()): ResolvedRange | undefined {
  if (!range.startDate || !range.endDate) return undefined;
  const start = DateTime.fromISO(range.startDate, { zone: timezone }).startOf("day");
  const end = DateTime.fromISO(range.endDate, { zone: timezone }).startOf("day");
  if (!start.isValid || !end.isValid) return undefined;
  const days = Math.round(end.diff(start, "days").days) + 1;
  if (days < 1) return undefined;
  const previousEnd = start.minus({ days: 1 });
  return {
    startDate: previousEnd.minus({ days: days - 1 }).toFormat("yyyy-MM-dd"),
    endDate: previousEnd.toFormat("yyyy-MM-dd"),
    label: `the previous ${days} day${days === 1 ? "" : "s"}`,
  };
}

export function timeStatementFor(range: ResolvedRange, timezone: string) {
  return getTimeStatement({ start_date: range.startDate, end_date: range.endDate, time_zone: timezone });
}

/**
 * Granularity that keeps a trend readable: hourly for a day or two, daily for a
 * month, weekly past that. The model can override it, but defaulting beats
 * letting it pick "hour" for a quarter and produce 2,000 points.
 */
export function defaultBucket(range: ResolvedRange): "hour" | "day" | "week" {
  if (!range.startDate || !range.endDate) return "day";
  const start = DateTime.fromISO(range.startDate);
  const end = DateTime.fromISO(range.endDate);
  if (!start.isValid || !end.isValid) return "day";
  const days = Math.round(end.diff(start, "days").days) + 1;
  if (days <= 2) return "hour";
  if (days > 70) return "week";
  return "day";
}
