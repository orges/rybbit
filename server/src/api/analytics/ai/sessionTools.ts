import { z } from "zod";
import { sanitizeUntrustedValue } from "../../../mcp/tools/shared.js";
import { runAnalyticsQuery } from "../utils/analyticsQuery.js";
import { digestForModel, digestSession, type SessionDigest, type TimelineRow } from "./sessionDigest.js";
import { resolveToolRange, timeStatementFor } from "./time.js";
import type { AnalystTool, ToolContext } from "./tools.js";

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

async function digestOne(ctx: ToolContext, sessionId: string): Promise<SessionDigest> {
  const range = resolveToolRange(undefined, ctx.defaultRange, ctx.timezone);
  const rows = await runAnalyticsQuery<Record<string, unknown>>({
    query: buildSessionTimelineQuery(timeStatementFor(range, ctx.timezone)),
    params: { siteId: ctx.siteId, sessionId, limit: MAX_TIMELINE_ROWS },
  });
  return digestSession(rows.map(toTimelineRow));
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
    },
    required: ["session_id"],
  },
  async run(args, ctx) {
    guard(ctx);
    const sessionId = sessionIdSchema.safeParse(String(args.session_id ?? "").trim());
    if (!sessionId.success) throw new Error("session_id is required");

    const digest = await digestOne(ctx, sessionId.data);
    if (!digest.steps.length && !digest.clicks.length) {
      return { text: JSON.stringify({ session_id: sessionId.data, found: false, note: "No interaction events for that session in this range." }) };
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
    },
    required: ["session_ids"],
  },
  async run(args, ctx) {
    guard(ctx);
    const parsed = z.array(sessionIdSchema).min(2).max(MAX_SESSIONS).safeParse(args.session_ids);
    if (!parsed.success) throw new Error(`Give between 2 and ${MAX_SESSIONS} session ids.`);

    const digests: Array<{ sessionId: string; digest: SessionDigest }> = [];
    for (const sessionId of parsed.data) digests.push({ sessionId, digest: await digestOne(ctx, sessionId) });
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
