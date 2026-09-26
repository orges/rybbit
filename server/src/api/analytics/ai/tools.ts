import type { Filter, FilterParameter } from "@rybbit/shared";
import { z } from "zod";
import { buildEventNamesQuery } from "../events/getEventNames.js";
import { buildEventPropertiesQuery } from "../events/getEventProperties.js";
import { buildErrorBucketedQuery } from "../getErrorBucketed.js";
import { buildErrorNamesQuery, type ErrorNameItem } from "../getErrorNames.js";
import { buildErrorEventsQuery } from "../getErrorEvents.js";
import { buildFunnelQuery } from "../funnels/getFunnel.js";
import { buildGoalsConversionsQuery, buildGoalsTotalSessionsQuery } from "../goals/getGoals.js";
import { buildGoalTimeSeriesQuery } from "../goals/getGoalTimeSeries.js";
import { buildJourneysQuery } from "../getJourneys.js";
import { buildMetricQuery } from "../getMetric.js";
import { buildPerformanceByDimensionQuery } from "../performance/getPerformanceByDimension.js";
import { buildPerformanceOverviewQuery } from "../performance/getPerformanceOverview.js";
import { buildPerformanceTimeSeriesQuery } from "../performance/getPerformanceTimeSeries.js";
import { buildRetentionQuery, processRetentionData } from "../getRetention.js";
import {
  buildChartQuery,
  buildMetricsSpecForWindow,
  buildOverviewQuery,
  type OverviewRow,
} from "../../../services/siteMetrics/siteMetrics.js";
import { executeScopedQuery } from "../runCustomQuery.js";
import { db } from "../../../db/postgres/postgres.js";
import { goals } from "../../../db/postgres/schema.js";
import { eq } from "drizzle-orm";
import { sanitizeClickhouseError } from "../utils/customQueryValidation.js";
import { runAnalyticsQuery, type QuerySpec } from "../utils/analyticsQuery.js";
import { SessionReplayQueryService } from "../../../services/replay/sessionReplayQueryService.js";
import { sanitizeUntrustedValue } from "../../../mcp/tools/shared.js";
import type { Artifact, ResultStore } from "./presentation.js";
import { defaultBucket, isTimePreset, previousRange, resolvePreset, timeStatementFor, type ResolvedRange } from "./time.js";

/**
 * The read-only analytics surface the analyst can reach.
 *
 * Every tool is a thin wrapper over a `build*Query` function that already backs a
 * dashboard page, so the chat cannot invent a metric the product does not show
 * and cannot reach data the caller is not allowed to see: the Site is bound as a
 * ClickHouse parameter and the filter set comes from the caller's session, never
 * from the model. The only free-form path is `run_sql`, which goes through the
 * same scoped-events validation as the Query page.
 */

export type ToolRow = Record<string, unknown>;

export interface ToolContext {
  siteId: number;
  siteIds: number[];
  timezone: string;
  /** The dashboard range the user is looking at, used when a tool omits `time`. */
  defaultRange: ResolvedRange;
  /** The dashboard's active filters, applied on top of every tool query. */
  filters: Filter[];
  /** Rows from earlier tool calls in this run, addressable by `result_id`. */
  results: ResultStore;
  signal: AbortSignal;
}

/** The window a tool actually queried, for a result that can be re-queried later. */
export type ToolRange = { startDate?: string; endDate?: string };

/**
 * Something for a person to review and save, returned by a proposal tool.
 * `value` is exactly the body the product's own create endpoint accepts.
 */
export interface ToolProposal {
  kind: string;
  value: Record<string, unknown>;
  reason: string;
}

export interface ToolOutput {
  /** What the model reads. Kept small: full rows live in the result store. */
  text: string;
  rows?: ToolRow[];
  /** Overrides the default columns/limit when previewing rows for the model. */
  preview?: { columns?: string[]; limit?: number };
  artifact?: Artifact;
  /** Set when the rows are over a fixed window, so an artifact can ask for the same one. */
  range?: ToolRange;
  proposal?: ToolProposal;
}

export interface AnalystTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

const timeShape = {
  type: "object",
  description: "Time range for this question. Omit to use the range the user is viewing.",
  properties: {
    preset: {
      type: "string",
      enum: [
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
      ],
    },
    start_date: { type: "string", description: "Inclusive start date, YYYY-MM-DD" },
    end_date: { type: "string", description: "Inclusive end date, YYYY-MM-DD" },
  },
} as const;

const timeArgsSchema = z
  .object({
    preset: z.string().optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .optional();

const rangeFor = (args: Record<string, unknown>, ctx: ToolContext): ResolvedRange => {
  const requested = timeArgsSchema.safeParse(args.time);
  if (!requested.success) throw new Error("Invalid time argument");
  const { preset, start_date, end_date } = requested.data ?? {};
  if (start_date || end_date) {
    if (!start_date || !end_date) throw new Error("Give both start_date and end_date, or use a preset");
    return { startDate: start_date, endDate: end_date, label: `${start_date} to ${end_date}` };
  }
  if (preset) {
    if (!isTimePreset(preset)) throw new Error(`Unknown time preset "${preset}"`);
    return resolvePreset(preset, ctx.timezone);
  }
  return ctx.defaultRange;
};

const filterString = (ctx: ToolContext) => (ctx.filters.length ? JSON.stringify(ctx.filters) : "");

/**
 * Every analyst query goes through here.
 *
 * Two things are cleaned on the way in: `FixedString` padding, which arrives as
 * NUL bytes and makes Postgres reject the transcript, and the control and
 * bidi-override characters an untrusted page title can carry. Both are the
 * model's context as much as the user's screen, so cleaning at the source fixes
 * all three consumers at once.
 */
async function query<T>(spec: QuerySpec): Promise<T[]> {
  return (await runAnalyticsQuery<T>(spec)).map(row => sanitizeUntrustedValue(row) as T);
}

// BaseParams wants strings, and an empty date reads as "no bound" in
// getTimeStatement, which is exactly what an all-time range means here.
const baseParams = (ctx: ToolContext, range: ResolvedRange) => ({
  filters: filterString(ctx),
  start_date: range.startDate ?? "",
  end_date: range.endDate ?? "",
  time_zone: ctx.timezone,
});

/** Trims a long text column so one chatty URL cannot blow the model's context. */
const compactCell = (value: unknown) => (typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}…` : value);

const compactRows = (rows: ToolRow[]) => rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, compactCell(v)])));

const percentChange = (current: number, previous: number) =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : undefined;

const formatNumber = (value: number) => Math.round(value * 100) / 100;

const OVERVIEW_METRICS: Array<{ key: keyof OverviewRow; label: string; higherIsBetter: boolean }> = [
  { key: "sessions", label: "Sessions", higherIsBetter: true },
  { key: "pageviews", label: "Pageviews", higherIsBetter: true },
  { key: "users", label: "Users", higherIsBetter: true },
  { key: "pages_per_session", label: "Pages per session", higherIsBetter: true },
  { key: "bounce_rate", label: "Bounce rate", higherIsBetter: false },
  { key: "session_duration", label: "Avg session duration (s)", higherIsBetter: true },
];

const getOverview: AnalystTool = {
  name: "get_overview",
  description:
    "Headline metrics for a time range: sessions, pageviews, users, pages per session, bounce rate and average session duration. Include `compare: true` to get the change against the previous period of the same length.",
  parameters: {
    type: "object",
    properties: { time: timeShape, compare: { type: "boolean", description: "Also return the previous period for comparison" } },
  },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    const params = baseParams(ctx, range);
    const current = await query<OverviewRow>({
      query: buildOverviewQuery(buildMetricsSpecForWindow(params.filters, ctx.siteId, timeStatementFor(range, ctx.timezone))),
      params: { siteId: ctx.siteId },
    });
    const row = current[0] ?? ({} as OverviewRow);
    const metrics = OVERVIEW_METRICS.map(({ key, label, higherIsBetter }) => {
      const value = Number(row[key] ?? 0);
      return { metric: label, value: formatNumber(value), unit: key === "session_duration" ? "seconds" : key === "bounce_rate" ? "percent" : "count", higher_is_better: higherIsBetter };
    });
    const result: Record<string, unknown> = { range: range.label, start_date: range.startDate, end_date: range.endDate, metrics };

    if (args.compare) {
      const previous = previousRange(range, ctx.timezone);
      if (previous) {
        const before = await query<OverviewRow>({
          query: buildOverviewQuery(
            buildMetricsSpecForWindow(params.filters, ctx.siteId, timeStatementFor(previous, ctx.timezone))
          ),
          params: { siteId: ctx.siteId },
        });
        const beforeRow = before[0] ?? ({} as OverviewRow);
        result.previous = {
          range: previous.label,
          start_date: previous.startDate,
          end_date: previous.endDate,
          metrics: OVERVIEW_METRICS.map(({ key, label }) => ({ metric: label, value: formatNumber(Number(beforeRow[key] ?? 0)) })),
        };
        result.change_percent = Object.fromEntries(
          OVERVIEW_METRICS.map(({ key, label }) => {
            const change = percentChange(Number(row[key] ?? 0), Number(beforeRow[key] ?? 0));
            return [label, change === undefined ? "no comparable previous data" : `${change > 0 ? "+" : ""}${change}%`];
          })
        );
      } else {
        result.change_percent = "unavailable: the selected range has no bounded previous period";
      }
    }
    return { text: JSON.stringify(result) };
  },
};

const getTimeseries: AnalystTool = {
  name: "get_timeseries",
  description:
    "Sessions and pageviews over time, bucketed by hour, day or week. Use this for trends and for 'what time were people most active'.",
  parameters: {
    type: "object",
    properties: {
      time: timeShape,
      bucket: { type: "string", enum: ["hour", "day", "week"], description: "Defaults to a granularity that fits the range" },
      compare: { type: "boolean", description: "Also return the previous period of the same length" },
    },
  },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    const bucket = (args.bucket as "hour" | "day" | "week" | undefined) ?? defaultBucket(range);
    const run = async (window: ResolvedRange) =>
      runAnalyticsQuery<{ time: string; sessions: number; pageviews: number }>({
        query: buildChartQuery(
          buildMetricsSpecForWindow(filterString(ctx), ctx.siteId, timeStatementFor(window, ctx.timezone)),
          bucket === "hour" ? "toStartOfHour" : bucket === "week" ? "toStartOfWeek" : "toStartOfDay"
        ),
        params: { siteId: ctx.siteId, timeZone: ctx.timezone },
      });
    const rows = await run(range);
    const result: Record<string, unknown> = { range: range.label, bucket, points: rows.length };
    if (args.compare) {
      const previous = previousRange(range, ctx.timezone);
      if (previous) {
        const before = await run(previous);
        result.previous = { range: previous.label, points: before.length };
        result.previous_series = before.slice(0, 200);
      }
    }
    return { text: JSON.stringify(result), rows, preview: { limit: 60 } };
  },
};

const BREAKDOWN_DIMENSIONS: FilterParameter[] = [
  "pathname",
  "page_title",
  "event_name",
  "referrer",
  "entry_page",
  "exit_page",
  "country",
  "region",
  "city",
  "browser",
  "operating_system",
  "device_type",
  "language",
  "hostname",
  "querystring",
  "channel",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "user_id",
];

const getBreakdown: AnalystTool = {
  name: "get_breakdown",
  description:
    "Top values of one dimension with session counts, share and pageviews. Dimensions include pathname, page_title, event_name, referrer, entry_page, exit_page, country, region, city, browser, operating_system, device_type, language, hostname, querystring, channel and the utm_* parameters.",
  parameters: {
    type: "object",
    properties: {
      dimension: { type: "string", enum: BREAKDOWN_DIMENSIONS },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Defaults to 20" },
      time: timeShape,
    },
    required: ["dimension"],
  },
  async run(args, ctx) {
    const dimension = String(args.dimension) as FilterParameter;
    if (!BREAKDOWN_DIMENSIONS.includes(dimension)) throw new Error(`Unsupported dimension "${dimension}"`);
    const range = rangeFor(args, ctx);
    const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
    const rows = await query<ToolRow>({
      query: buildMetricQuery({ ...baseParams(ctx, range), parameter: dimension, limit }, ctx.siteId),
      params: { siteId: ctx.siteId },
    });
    return {
      text: JSON.stringify({
        dimension,
        range: range.label,
        total: rows.length,
        rows: rows.slice(0, 10).map(row => compactRow(row)),
      }),
      rows,
      preview: { limit: 50 },
    };
  },
};

const listEventNames: AnalystTool = {
  name: "list_event_names",
  description:
    "Custom event names recorded in a time range, with occurrence counts. Call this before guessing how a concept is tracked — the right event name is often not obvious from the product vocabulary.",
  parameters: { type: "object", properties: { time: timeShape, limit: { type: "integer", minimum: 1, maximum: 200 } } },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    const rows = await query<{ eventName: string; count: number }>({
      query: buildEventNamesQuery({ ...baseParams(ctx, range), event_name: "" }, ctx.siteId),
      params: { siteId: ctx.siteId },
    });
    return { text: JSON.stringify({ range: range.label, count: rows.length, events: rows.slice(0, 40) }), rows, preview: { limit: 50 } };
  },
};

const getEventProperties: AnalystTool = {
  name: "get_event_properties",
  description: "Property names seen on a custom event, with how often each one is set. Use it to find the property holding an id, name or category.",
  parameters: {
    type: "object",
    properties: { event_name: { type: "string" }, time: timeShape },
    required: ["event_name"],
  },
  async run(args, ctx) {
    const eventName = String(args.event_name ?? "").trim();
    if (!eventName) throw new Error("event_name is required");
    const range = rangeFor(args, ctx);
    const rows = await query<{ propertyKey: string; propertyValue: string; count: number }>({
      query: buildEventPropertiesQuery({ ...baseParams(ctx, range), event_name: eventName }, ctx.siteId),
      params: { siteId: ctx.siteId, eventName },
    });
    const properties: Array<{ property: string; values: Array<{ value: string; count: number }> }> = [];
    for (const row of rows.slice(0, 300)) {
      const key = String(row.propertyKey ?? "");
      if (!key) continue;
      const entry = properties.find(item => item.property === key);
      if (!entry) properties.push({ property: key, values: [{ value: String(row.propertyValue ?? ""), count: Number(row.count ?? 0) }] });
      else if (entry.values.length < 5) entry.values.push({ value: String(row.propertyValue ?? ""), count: Number(row.count ?? 0) });
    }
    return {
      text: JSON.stringify({ event_name: eventName, properties: properties.slice(0, 25) }),
      rows,
      preview: { limit: 50 },
    };
  },
};

const getErrors: AnalystTool = {
  name: "get_errors",
  description:
    "Top JavaScript errors in a time range: message, error type, occurrences and sessions affected. Pass `error_message` to get the hourly or daily timeline of one specific error.",
  parameters: {
    type: "object",
    properties: {
      time: timeShape,
      limit: { type: "integer", minimum: 1, maximum: 50 },
      error_message: { type: "string", description: "Exact message to chart over time" },
    },
  },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    const params = baseParams(ctx, range);
    if (args.error_message) {
      const bucket = defaultBucket(range);
      const rows = await query<ToolRow>({
        query: buildErrorBucketedQuery(
          { ...params, bucket: bucket === "week" ? "day" : bucket, errorMessage: String(args.error_message) },
          ctx.siteId
        ),
        params: { siteId: ctx.siteId, errorMessage: String(args.error_message) },
      });
      return { text: JSON.stringify({ error_message: args.error_message, range: range.label, bucket, points: rows.length }), rows, preview: { limit: 60 } };
    }
    const rows = await query<ErrorNameItem>({
      query: buildErrorNamesQuery({ ...params, limit: Math.min(Number(args.limit ?? 10), 50) }, ctx.siteId),
      params: { siteId: ctx.siteId },
    });
    return { text: JSON.stringify({ range: range.label, count: rows.length, errors: rows.slice(0, 10) }), rows, preview: { limit: 50 } };
  },
};

const getWebVitals: AnalystTool = {
  name: "get_web_vitals",
  description:
    "Core Web Vitals percentiles (LCP, CLS, INP, FCP, TTFB) for a time range, optionally split by page, country, device, browser, OS or region.",
  parameters: {
    type: "object",
    properties: {
      time: timeShape,
      dimension: { type: "string", enum: ["pathname", "country", "device_type", "browser", "operating_system", "region"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    const params = baseParams(ctx, range);
    if (args.dimension) {
      const rows = await query<ToolRow>({
        query: buildPerformanceByDimensionQuery(
          { ...params, dimension: String(args.dimension), limit: Math.min(Number(args.limit ?? 20), 50) },
          ctx.siteId
        ),
        params: { siteId: ctx.siteId },
      });
      return { text: JSON.stringify({ dimension: args.dimension, range: range.label, rows: rows.slice(0, 15) }), rows, preview: { limit: 50 } };
    }
    const overview = await query<ToolRow>({ query: buildPerformanceOverviewQuery(params, ctx.siteId), params: { siteId: ctx.siteId } });
    const trend = await query<ToolRow>({
      query: buildPerformanceTimeSeriesQuery(
        { ...params, bucket: defaultBucket(range) === "hour" ? "hour" : "day" },
        ctx.siteId
      ),
      params: { siteId: ctx.siteId },
    });
    return { text: JSON.stringify({ range: range.label, percentiles: overview }), rows: trend, preview: { limit: 60 } };
  },
};

const getRetention: AnalystTool = {
  name: "get_retention",
  description:
    "Cohort retention: for each day or week a user first appeared, the share of those users who came back in later periods. Returns cohorts of {cohort date, size, retained_percent per period}.",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["day", "week"] },
      range: { type: "integer", minimum: 7, maximum: 365, description: "Days to look back. Defaults to 30" },
    },
  },
  async run(args, ctx) {
    const mode = args.mode === "week" ? "week" : "day";
    const range = Math.min(Math.max(Number(args.range ?? 30), 7), 365);
    const rows = await query<{
      cohort_period: string;
      period_difference: number;
      cohort_size: number;
      retained_users: number;
      retention_percentage: number;
    }>({ query: buildRetentionQuery(mode), params: { siteId: ctx.siteId, timeRange: range } });
    const processed = processRetentionData(rows);
    const cohorts = Object.entries(processed.cohorts)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 14)
      .map(([cohort, { size, percentages }]) => ({ cohort, size, retained_percent: percentages.slice(0, 8).map(value => (value === null ? null : formatNumber(value))) }));
    return {
      text: JSON.stringify({ mode, range_days: range, cohorts: cohorts.slice(0, 6), total_cohorts: Object.keys(processed.cohorts).length }),
      // Retention is a grid; without the rows there is nothing for show_retention
      // to draw and the answer can only be prose.
      rows: rows as ToolRow[],
    };
  },
};

const getFunnel: AnalystTool = {
  name: "get_funnel",
  description:
    "Conversion through an ordered sequence of steps. Each step is a page path or a custom event name. Returns step_number, step_name, sessions, conversion_rate and dropoff_rate — chartable as step_name against sessions.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: {
          type: "object",
          properties: { type: { type: "string", enum: ["page", "event"] }, value: { type: "string" } },
          required: ["type", "value"],
        },
      },
      time: timeShape,
    },
    required: ["steps"],
  },
  async run(args, ctx) {
    const steps = z
      .array(z.object({ type: z.enum(["page", "event"]), value: z.string().min(1).max(500) }))
      .min(2)
      .max(6)
      .safeParse(args.steps);
    if (!steps.success) throw new Error("steps must be 2 to 6 page or event steps");
    const range = rangeFor(args, ctx);
    const rows = await query<ToolRow>({
      query: buildFunnelQuery(baseParams(ctx, range), ctx.siteId, steps.data),
      params: { siteId: ctx.siteId, stepNumber: steps.data.length },
    });
    return {
      text: JSON.stringify({ range: range.label, steps: steps.data, results: rows }),
      rows,
      preview: { limit: 20 },
      range: { startDate: range.startDate, endDate: range.endDate },
    };
  },
};

const getErrorEvents: AnalystTool = {
  name: "get_error_events",
  description:
    "The individual occurrences of one exact error message: when it happened, which page and browser it happened on, and the session it happened in — session_id opens that recording in Replay. Pass the message exactly as get_errors returned it.",
  parameters: {
    type: "object",
    properties: {
      error_message: { type: "string", description: "The exact error message from get_errors" },
      time: timeShape,
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["error_message"],
  },
  async run(args, ctx) {
    const message = z.string().min(1).max(2000).safeParse(args.error_message);
    if (!message.success) throw new Error("error_message is required, exactly as get_errors returned it");
    const range = rangeFor(args, ctx);
    const rows = await query<ToolRow>({
      query: buildErrorEventsQuery(
        { ...baseParams(ctx, range), errorMessage: message.data, limit: Math.min(Number(args.limit ?? 20), 50) },
        ctx.siteId
      ),
      params: { siteId: ctx.siteId, errorMessage: message.data },
    });
    return {
      text: JSON.stringify({
        range: range.label,
        error_message: message.data,
        count: rows.length,
        sessions: [...new Set(rows.map(row => String(row.session_id ?? "")).filter(Boolean))].slice(0, 20),
      }),
      rows,
      // The stack and the message repeat on every row; the model needs the page,
      // the session and the context, not the same text twenty times.
      preview: { columns: ["timestamp", "message", "session_id", "hostname", "pathname", "country", "browser", "device_type"], limit: 20 },
      // So a session link opens the recording inside the window the answer was
      // about, rather than whatever range the dashboard happens to be on.
      range: { startDate: range.startDate, endDate: range.endDate },
    };
  },
};

const getGoalsTool: AnalystTool = {
  name: "get_goals",
  description:
    "The goals configured on this Site, with the sessions and conversions each one got over a range, its conversion rate, and whether the rate is rising or falling. Use it for any question about goals, targets, or 'are we on track'.",
  parameters: {
    type: "object",
    properties: {
      time: timeShape,
      goal: { type: "string", description: "Only this goal, by name or id. Omit for all of them." },
    },
  },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    const params = baseParams(ctx, range);
    // The Site is the caller's, never the model's: a goal from another Site is
    // not readable through this tool at all.
    const all = await db.select().from(goals).where(eq(goals.siteId, ctx.siteId));
    if (!all.length) {
      return {
        text: JSON.stringify({
          range: range.label,
          goals: [],
          note: "This Site has no goals yet. Say so rather than guessing what they might be, and offer to help set one up.",
        }),
      };
    }
    const wanted = args.goal ? all.filter(goal => matchesGoal(goal, String(args.goal))) : all;
    if (args.goal && !wanted.length) {
      return {
        text: JSON.stringify({
          range: range.label,
          goals: [],
          available: all.map(goal => goalLabel(goal)),
          note: `No goal matches "${args.goal}".`,
        }),
      };
    }

    const sessionsData = await query<{ total_sessions: number }>({
      query: buildGoalsTotalSessionsQuery(params, ctx.siteId),
    });
    const totalSessions = Number(sessionsData[0]?.total_sessions ?? 0);
    const conversionsQuery = buildGoalsConversionsQuery(params, ctx.siteId, wanted);
    const conversions = conversionsQuery ? await query<Record<string, number>>({ query: conversionsQuery }) : [];
    const counted = conversions[0] ?? {};

    const trend = await goalTrend(ctx, wanted, params, range);
    const rows = wanted.map(goal => {
      const goalConversions = Number(counted[`goal_${goal.goalId}_conversions`] ?? 0);
      const rate = totalSessions > 0 ? goalConversions / totalSessions : 0;
      const movement = trend.get(goal.goalId);
      return {
        goal_id: goal.goalId,
        name: goal.name || goalLabel(goal),
        goal_type: goal.goalType,
        target: goalTarget(goal),
        sessions: totalSessions,
        conversions: goalConversions,
        conversion_rate: formatNumber(rate * 100),
        ...(movement ? { trend: movement } : {}),
      };
    });
    return {
      text: JSON.stringify({
        range: range.label,
        sessions: totalSessions,
        goals: rows.map(row => ({ ...row, target: undefined })),
      }),
      rows,
      preview: { columns: ["name", "goal_type", "target", "conversions", "sessions", "conversion_rate"], limit: 25 },
    };
  },
};

/** A goal the model named by id, exact name, or the condition it matches. */
const matchesGoal = (goal: (typeof goals.$inferSelect), wanted: string) => {
  const needle = wanted.trim().toLowerCase();
  return (
    String(goal.goalId) === needle ||
    (goal.name ?? "").toLowerCase() === needle ||
    goalLabel(goal).toLowerCase().includes(needle) ||
    JSON.stringify(goal.config ?? {}).toLowerCase().includes(needle)
  );
};

/** What the goal actually counts, in words: the path or event behind it. */
const goalLabel = (goal: (typeof goals.$inferSelect)) => {
  if (goal.name) return goal.name;
  const config = (goal.config ?? {}) as { pathPattern?: string; eventName?: string; valuePattern?: string };
  return config.pathPattern || config.eventName || config.valuePattern || goal.goalType;
};

/** The pattern a goal watches for, so the answer can say what would count. */
const goalTarget = (goal: (typeof goals.$inferSelect)) => {
  const config = (goal.config ?? {}) as { pathPattern?: string; eventName?: string; valuePattern?: string };
  return config.pathPattern || config.eventName || config.valuePattern || "";
};

/**
 * Rising or falling, from the same series the Goals page draws.
 *
 * A conversion rate on its own says where a goal is; the direction is what makes
 * it a question worth asking, so this is the difference between "3.1%" and
 * "3.1%, down from 4.4% six weeks ago".
 */
async function goalTrend(
  ctx: ToolContext,
  siteGoals: (typeof goals.$inferSelect)[],
  params: ReturnType<typeof baseParams>,
  range: ResolvedRange
) {
  const sql = buildGoalTimeSeriesQuery({ ...params, bucket: defaultBucket(range) }, ctx.siteId, siteGoals);
  if (!sql) return new Map<number, string>();
  let series: Array<{ goal_id: number; conversion_rate: number | string }>;
  try {
    series = await query({ query: sql, params: { siteId: ctx.siteId, timeZone: ctx.timezone } });
  } catch {
    // A trend is a nicety; the counts are the answer.
    return new Map<number, string>();
  }
  const movement = new Map<number, string>();
  for (const goal of siteGoals) {
    const rates = series
      .filter(row => Number(row.goal_id) === goal.goalId)
      .map(row => Number(row.conversion_rate) * 100)
      .filter(Number.isFinite);
    if (rates.length < 2) continue;
    // Compare the two ends of the range rather than one period to the next.
    const window = Math.max(1, Math.round(rates.length / 3));
    const early = average(rates.slice(0, window));
    const late = average(rates.slice(-window));
    // Only a zero baseline is unusable. A goal that stopped converting entirely
    // is late = 0, and "down 100%" is exactly what someone needs to hear.
    if (!early) continue;
    const delta = Math.round(((late - early) / early) * 1000) / 10;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1) continue;
    movement.set(goal.goalId, `${delta > 0 ? "up" : "down"} ${Math.abs(delta)}%`);
  }
  return movement;
}

const average = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;

const getJourneys: AnalystTool = {
  name: "get_journeys",
  description: "The most common sequences of pages inside a session, ranked by how many sessions took them.",
  parameters: {
    type: "object",
    properties: {
      max_steps: { type: "integer", minimum: 2, maximum: 10, description: "Longest path to consider. Defaults to 3" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many distinct paths to return. Defaults to 10" },
      time: timeShape,
    },
  },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    // Path length and how many paths to return; the dashboard defaults are 3 and
    // 100, and the builder binds both.
    const maxSteps = Math.min(Math.max(Number(args.max_steps ?? 3), 2), 10);
    const journeyLimit = Math.min(Math.max(Number(args.limit ?? 10), 1), 100);
    const rows = await query<{ journey: string[]; sessions_count: number; percentage: number }>({
      query: buildJourneysQuery({ ...baseParams(ctx, range), steps: String(maxSteps) }, ctx.siteId, {}),
      params: { siteId: ctx.siteId, maxSteps, journeyLimit },
    });
    return { text: JSON.stringify({ range: range.label, count: rows.length, journeys: rows.slice(0, 5) }), rows, preview: { limit: 20 } };
  },
};

const searchReplays: AnalystTool = {
  name: "search_replays",
  description:
    "Find recorded sessions matching filters, with their duration, entry page, country, browser and device. Returns session IDs the user can open in Replay.",
  parameters: {
    type: "object",
    properties: {
      time: timeShape,
      limit: { type: "integer", minimum: 1, maximum: 20 },
      min_duration: { type: "integer", minimum: 0, description: "Only sessions at least this many seconds long" },
      user_id: { type: "string" },
    },
  },
  async run(args, ctx) {
    const range = rangeFor(args, ctx);
    const sessions = await new SessionReplayQueryService().getSessionReplayList(ctx.siteId, {
      ...baseParams(ctx, range),
      limit: Math.min(Number(args.limit ?? 10), 20),
      ...(args.min_duration ? { minDuration: Number(args.min_duration) } : {}),
      ...(args.user_id ? { userId: String(args.user_id) } : {}),
    });
    const rows = sessions as unknown as ToolRow[];
    return {
      text: JSON.stringify({
        range: range.label,
        count: rows.length,
        sessions: rows.slice(0, 10).map(row => ({
          session_id: row.sessionId,
          duration_seconds: row.duration,
          entry_page: row.entryPage,
          country: row.country,
          browser: row.browser,
          device_type: row.deviceType,
        })),
      }),
      rows,
      preview: { limit: 20 },
    };
  },
};

// The scoped query already caps at 1000 rows. Keep the whole set so a chart can
// plot it; only the copy handed to the model is shortened.
const MAX_SQL_ROWS = 1000;

const runSql: AnalystTool = {
  name: "run_sql",
  description:
    "Run a read-only ClickHouse query when no other tool answers the question. The only table is `scoped_events`, one statement, no DDL. Prefer the tools above when one fits.",
  parameters: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single SELECT or WITH statement reading FROM scoped_events" },
      purpose: { type: "string", description: "One line on what this query answers" },
    },
    required: ["sql"],
  },
  async run(args, ctx) {
    const sql = String(args.sql ?? "").slice(0, 20000);
    const { data: raw } = await executeScopedQuery(sql, ctx.siteIds);
    const data = raw.map(row => sanitizeUntrustedValue(row) as ToolRow);
    const rows = data.slice(0, MAX_SQL_ROWS);
    return {
      text: JSON.stringify({
        purpose: args.purpose ?? null,
        rows: rows.length,
        columns: rows[0] ? Object.keys(rows[0]) : [],
        truncated: data.length > MAX_SQL_ROWS,
        preview: rows.slice(0, 15),
      }),
      rows,
      preview: { limit: 50 },
    };
  },
};

const compactRow = (row: ToolRow) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, compactCell(value)]));

export const ANALYST_TOOLS: AnalystTool[] = [
  getOverview,
  getTimeseries,
  getBreakdown,
  listEventNames,
  getEventProperties,
  getErrors,
  getErrorEvents,
  getWebVitals,
  getRetention,
  getFunnel,
  getGoalsTool,
  getJourneys,
  searchReplays,
  runSql,
];

/** Surfaces a failed tool call to the model instead of aborting the run. */
export function toolFailure(name: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "The tool failed unexpectedly";
  return `Tool "${name}" failed: ${sanitizeToolMessage(message)}. Fix the arguments and try again, or answer without it.`;
}

/**
 * ClickHouse errors can name tables, columns and settings, so they go through the
 * same scrubber the Query page uses. The model's own argument errors must not:
 * "column X is not in r1" is exactly what it needs to correct itself, and the
 * scrubber would flatten it to "Failed to run query".
 */
function sanitizeToolMessage(message: string) {
  if (!/DB::Exception|Code: \d+/.test(message)) return message.slice(0, 300);
  try {
    return sanitizeClickhouseError(new Error(message));
  } catch {
    return message.slice(0, 300);
  }
}

export const __testing = { rangeFor, percentChange, compactRows };
