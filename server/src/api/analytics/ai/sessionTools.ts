import { z } from "zod";
import { sanitizeUntrustedValue } from "../../../mcp/tools/shared.js";
import { runAnalyticsQuery } from "../utils/analyticsQuery.js";
import { digestForModel, digestSession, type SessionDigest, type TimelineRow } from "./sessionDigest.js";
import { isTimePreset, resolvePreset, timeStatementFor } from "./time.js";
import type { AnalystTool, ToolContext } from "./tools.js";

/** Matches the other tools: a session is read in a range, chosen server-side. */
const timeShape = {
  type: "object",
  description: "When to look for the session. A session id carries no date, so without this the dashboard's current range is used and older sessions are unreachable. Defaults to the last 90 days.",
  properties: {
    preset: { type: "string", enum: ["today", "yesterday", "last_7_days", "last_14_days", "last_30_days", "last_90_days", "this_month", "last_month", "all_time"] },
    start_date: { type: "string", description: "Inclusive start date, YYYY-MM-DD" },
    end_date: { type: "string", description: "Inclusive end date, YYYY-MM-DD" },
  },
} as const;

/**
 * Reading what visitors actually did.
 *
 * The interaction stream is already recorded as analytics events — pageviews,
 * button clicks, form submits, field touches, copies, outbound, errors — so this
 * does not read session replay. It reduces those events to structure, which buys
 * two things the replay route could not promise:
 *
 * - **No typed content.** `input_change` never records a value, so the digest
 *   cannot contain what someone typed. Copied text is the one visitor-authored
 *   prop and it is dropped, keeping only its length.
 * - **No page content.** Nothing here is DOM text, so a third-party widget cannot
 *   feed the model a paragraph of its own choosing.
 *
 * What it costs: the analyst can say a visitor touched the postcode field and
 * never submitted the form, but not what was in it.
 */

/** The most rows read for one session. A busy one is a few hundred. */
const MAX_TIMELINE_ROWS = 2_000;
/** Sessions one comparison may digest. */
const MAX_SESSIONS = 20;

/**
 * The interaction events, in order, for one session.
 *
 * Dashboard filters are deliberately not applied: a digest of a filtered session
 * is a fiction. Filtering to one path removes the pageview that says where the
 * session started, and the result reads as a journey that never happened. The
 * range still applies, so the model can bound it.
 */
const buildSessionTimelineQuery = (timeStatement: string) => `
  SELECT
    toUnixTimestamp64Milli(timestamp_ms) AS timestamp,
    type,
    event_name,
    pathname,
    props
  FROM events
  PREWHERE site_id = {siteId:UInt16}
    AND session_id = {sessionId:String}
    ${timeStatement}
    AND type IN ('pageview','button_click','form_submit','input_change','copy','outbound','error','custom_event')
  ORDER BY timestamp_ms ASC
  LIMIT {limit:UInt32}
`;

function toTimelineRow(item: unknown): TimelineRow {
  const row = sanitizeUntrustedValue((item ?? {}) as Record<string, unknown>) as Record<string, unknown>;
  const props = row.props && typeof row.props === "object" ? (row.props as Record<string, unknown>) : null;
  return {
    timestamp: Number(row.timestamp ?? 0),
    type: String(row.type ?? ""),
    event_name: row.event_name == null ? undefined : String(row.event_name),
    pathname: row.pathname == null ? undefined : String(row.pathname),
    props,
  };
}

/**
 * The window to read a session in.
 *
 * A session id carries no date of its own, so without a `time` argument this can
 * only ever read whatever range the dashboard is currently on — and the model has
 * no way to widen it, which makes every older session unreachable. Sessions are
 * also older than the range people are usually looking at, so the fallback is the
 * widest range rather than the dashboard's: being unable to see something is a
 * worse failure than reading a window that is too wide.
 */
export function windowFor(args: Record<string, unknown>, ctx: ToolContext) {
  const requested = z
    .object({
      preset: z.string().optional(),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .safeParse(args.time);

  if (requested.success && requested.data) {
    const { preset, start_date, end_date } = requested.data;
    if (start_date || end_date) {
      if (!start_date || !end_date) throw new Error("Give both start_date and end_date, or use a preset");
      return { startDate: start_date, endDate: end_date, label: `${start_date} to ${end_date}` };
    }
    if (preset) {
      if (!isTimePreset(preset)) throw new Error(`Unknown time preset "${preset}"`);
      return resolvePreset(preset, ctx.timezone);
    }
  }
  return ctx.defaultRange.startDate ? ctx.defaultRange : resolvePreset("last_90_days", ctx.timezone);
}

async function digestOne(ctx: ToolContext, sessionId: string, args: Record<string, unknown>): Promise<SessionDigest> {
  const range = windowFor(args, ctx);
  // One row over the cap, so a session with more events than we read is *known*
  // to have had them. Reading exactly the cap and stopping cannot tell the
  // difference between "that was all of it" and "there was more", and a digest
  // that quietly undercounts clicks is worse than one that admits it is partial.
  const rows = await runAnalyticsQuery<Record<string, unknown>>({
    query: buildSessionTimelineQuery(timeStatementFor(range, ctx.timezone)),
    params: { siteId: ctx.siteId, sessionId, limit: MAX_TIMELINE_ROWS + 1 },
  });
  const eventsTruncated = rows.length > MAX_TIMELINE_ROWS;
  const digest = digestSession((eventsTruncated ? rows.slice(0, MAX_TIMELINE_ROWS) : rows).map(toTimelineRow));
  return eventsTruncated ? { ...digest, eventsTruncated: true, eventCount: rows.length } : digest;
}

const sessionIdSchema = z.string().min(1).max(64);

/**
 * Tied to the Site's session replay setting rather than a switch of its own.
 *
 * Reusing an existing per-site boolean keeps the promise narrow: the analyst reads
 * sessions only where you already record them, and the answer stays where a
 * visitor would expect it — Site Settings.
 */
const guard = (ctx: ToolContext) => {
  if (!ctx.sessionReplay) {
    throw new Error(
      "Reading what a visitor did in a session is off for this Site. It follows the session replay setting in Site Settings — turn that on to use it."
    );
  }
};

const getSessionTimeline: AnalystTool = {
  name: "get_session_timeline",
  description:
    "What one visitor did, as structure: the pages they visited in order with time on each, what they clicked and how often, which form fields they touched, whether the form was submitted, errors, and outbound links. Never contains anything they typed. Get session ids from search_replays or get_error_events first.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "The session to read, as returned by search_replays or get_error_events" },
      time: timeShape,
    },
    required: ["session_id"],
  },
  async run(args, ctx) {
    guard(ctx);
    const sessionId = sessionIdSchema.safeParse(String(args.session_id ?? "").trim());
    if (!sessionId.success) throw new Error("session_id is required");

    const digest = await digestOne(ctx, sessionId.data, args);
    if (!digest.steps.length && !digest.clicks.length) {
      return {
        text: JSON.stringify({
          session_id: sessionId.data,
          found: false,
          searched: windowFor(args, ctx).label,
          note: "No interaction events for that session in that window. A session id carries no date, so widen the range with `time` — the session may be older than the dashboard's current range.",
        }),
      };
    }
    // No rows on purpose: a digest is not chartable, and the answer is the prose.
    return { text: JSON.stringify(digestForModel(digest, sessionId.data)) };
  },
};

const analyseSessions: AnalystTool = {
  name: "analyse_sessions",
  description:
    "Compare sessions and report what they share: the page where they stopped, controls clicked that led nowhere, form fields touched but never submitted, errors that repeat. This is how a suggestion earns its evidence — one session is a story, several are a pattern. Give it 2 to 20 session ids.",
  parameters: {
    type: "object",
    properties: {
      session_ids: {
        type: "array",
        minItems: 2,
        maxItems: MAX_SESSIONS,
        items: { type: "string" },
        description: "Sessions to compare, as returned by search_replays or get_error_events",
      },
      time: timeShape,
    },
    required: ["session_ids"],
  },
  async run(args, ctx) {
    guard(ctx);
    const parsed = z.array(sessionIdSchema).min(2).max(MAX_SESSIONS).safeParse(args.session_ids);
    if (!parsed.success) throw new Error(`Give between 2 and ${MAX_SESSIONS} session ids.`);

    const digests: Array<{ sessionId: string; digest: SessionDigest }> = [];
    for (const sessionId of parsed.data) digests.push({ sessionId, digest: await digestOne(ctx, sessionId, args) });
    const found = digests.filter(entry => entry.digest.steps.length || entry.digest.clicks.length);
    if (!found.length) {
      return { text: JSON.stringify({ sessions_given: parsed.data.length, with_events: 0, note: "None of those sessions have interaction events in this range." }) };
    }

    // What recurs. A pattern is something that happened in more than one session,
    // which is the only kind worth telling someone to act on.
    const shared = (pick: (digest: SessionDigest) => string[]) => {
      const counts = new Map<string, number>();
      for (const { digest } of found) for (const key of pick(digest)) counts.set(key, (counts.get(key) ?? 0) + 1);
      return [...counts.entries()]
        .filter(([, sessions]) => sessions > 1)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([what, sessions]) => ({ what, sessions }));
    };

    return {
      text: JSON.stringify({
        sessions_compared: found.length,
        shared_exit_pages: shared(digest => (digest.exitPage ? [digest.exitPage] : [])),
        shared_dead_clicks: shared(digest => digest.deadClicks.map(click => `${click.label} on ${click.path} (×${click.count})`)),
        forms_touched_not_submitted: shared(digest =>
          digest.forms.filter(form => !form.submitted).map(form => `${form.name} (${form.fields.join(", ") || "no fields"})`)
        ),
        repeated_errors: shared(digest => [...new Set(digest.errors.map(error => error.message))]),
        where_they_stalled: found
          .map(({ sessionId, digest }) => ({
            session_id: sessionId,
            ended_on: digest.exitPage,
            seconds_on_last_page: digest.steps[digest.steps.length - 1]?.dwell ?? 0,
          }))
          .sort((left, right) => right.seconds_on_last_page - left.seconds_on_last_page)
          .slice(0, 5),
        note: "Something in two or more sessions is a pattern worth reporting. One session is not a pattern.",
      }),
    };
  },
};

export const SESSION_TOOLS: AnalystTool[] = [getSessionTimeline, analyseSessions];
