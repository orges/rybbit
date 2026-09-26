/**
 * What happened in a session, reduced to structure.
 *
 * The interaction stream is already in the events table — pageviews, button
 * clicks, form submits, input changes, copies, outbound, errors — one row per
 * thing a visitor did, in order, with the page they were on. This turns that into
 * something a model can reason over in a few hundred tokens instead of a
 * firehose of raw rows.
 *
 * Two properties are load-bearing and both come from the tracker, not from here:
 *
 * 1. **No typed content, ever.** `input_change` records the element, the input
 *    type, the field name and the form — never the value. A digest built from
 *    these rows is therefore structurally incapable of containing what someone
 *    typed. Copied text is the one prop that *is* visitor-authored, so it is
 *    dropped below and only its length is kept.
 * 2. **Only site-authored strings survive.** Paths and button labels are written
 *    by whoever built the site. They are still untrusted — a label can be
 *    attacker-authored — so they are length-capped and stripped of control
 *    characters, and the system prompt already tells the model to treat every
 *    string a tool returns as data.
 */

/** One row of the interaction stream. */
export interface TimelineRow {
  /** Milliseconds since the epoch. */
  timestamp: number;
  type: string;
  event_name?: string;
  pathname?: string;
  props?: Record<string, unknown> | null;
}

export interface DigestStep {
  path: string;
  /** Seconds from the start of the session. */
  at: number;
  /** Seconds spent on this page before the next one, or before the session ended. */
  dwell: number;
}

export interface DigestClick {
  label: string;
  path: string;
  count: number;
  at: number;
}

export interface DigestField {
  /** The field's name, id, aria-label or placeholder. Never its value. */
  name: string;
  kind: string;
  count: number;
}

export interface DigestForm {
  name: string;
  submitted: boolean;
  fields: string[];
}

export interface DigestError {
  message: string;
  /** "TypeError", "unhandledrejection" — the error's type, not its text. */
  kind: string;
  at: number;
}

export interface SessionDigest {
  /** A list was cut at MAX_ITEMS, so this is a summary of a part. */
  truncated: boolean;
  /**
   * The event stream itself was cut at the row cap, so every count here is a
   * floor rather than a total. Distinct from `truncated`: this one means the
   * numbers are wrong, not that a list is short.
   */
  eventsTruncated?: boolean;
  /** The journey held more pageviews than the digest keeps. */
  stepsTruncated?: boolean;
  /** Events that existed, which may be more than were read. */
  eventCount?: number;
  durationSeconds: number;
  entryPage: string;
  exitPage: string;
  steps: DigestStep[];
  clicks: DigestClick[];
  /** Clicks with no pageview or submit after them — see DEAD_CLICK_WINDOW. */
  deadClicks: DigestClick[];
  fields: DigestField[];
  forms: DigestForm[];
  errors: DigestError[];
  customEvents: Array<{ name: string; count: number }>;
  outbound: string[];
  totals: {
    pageviews: number;
    clicks: number;
    formSubmits: number;
    fieldsTouched: number;
    errors: number;
  };
}

/**
 * A click with nothing happening after it.
 *
 * The window is the heuristic, and it is a real one: a click that opens a modal,
 * expands a menu or filters a list produces no pageview, so this will call some
 * of those dead. It errs toward reporting too many rather than too few, because
 * the useful question is "did this button do anything" and a false positive costs
 * one wasted click in the replay.
 */
const DEAD_CLICK_WINDOW_MS = 2_000;

/**
 * Cap per list.
 *
 * Grouping does not bound a session where every control is distinct — a hundred
 * unique labels still produce a hundred rows — so the lists are cut and say they
 * were cut. A digest is a summary; if it is losing the tail, the cap is visible
 * rather than a quiet lie about what was read.
 */
const MAX_ITEMS = 20;

/**
 * Steps kept, and from both ends.
 *
 * Steps are the one list that is not naturally bounded: a session that browses for
 * two hours has thousands of pageviews, and a two-thousand-entry journey tells a
 * reader nothing. The first and last are kept because they are the informative
 * ends — where it started and where it ended up — and the middle is where a
 * summary belongs.
 */
const MAX_STEPS = 40;

/** A label long enough to identify a control, short enough not to smuggle a page. */
const MAX_LABEL = 80;
const MAX_PATH = 200;
const MAX_ERROR = 160;

/** The only props read per event type. Anything absent is a visitor's data. */
const PROPS_ALLOWED: Record<string, string[]> = {
  button_click: ["text"],
  form_submit: ["formName", "formId"],
  input_change: ["inputName", "inputType", "element", "formName"],
  // `text` here is what the visitor copied, so it is deliberately not read.
  copy: ["textLength", "sourceElement"],
  outbound: ["url", "domain"],
  // The message is the useful half; `stack` is not read, and that is deliberate
  // rather than an oversight — a stack names the visitor's own browser extensions
  // and their installed software, which is neither useful to an analyst nor the
  // analyst's business.
  error: ["message", "type"],
  custom_event: [],
};

function text(value: unknown, max = MAX_LABEL): string {
  if (value === null || value === undefined) return "";
  return String(value)
    // Control characters and bidi overrides: the same set the query path scrubs,
    // so a label cannot disguise itself or break the transcript it lands in.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const str = (props: Record<string, unknown> | null | undefined, key: string, max = MAX_LABEL) => {
  if (!props) return "";
  return text(props[key], max);
};

const count = (rows: TimelineRow[], type: string) => rows.filter(row => row.type === type).length;

/**
 * Reduces an ordered interaction stream to a digest.
 *
 * Pure and synchronous so the whole thing is testable without ClickHouse, a
 * model, or a network — which is where the value and the risk both live.
 */
export function digestSession(rows: TimelineRow[], opts: { endTimestamp?: number } = {}): SessionDigest {
  const ordered = [...rows].sort((left, right) => left.timestamp - right.timestamp);
  const first = ordered[0]?.timestamp ?? 0;
  const last = ordered.length ? ordered[ordered.length - 1].timestamp : first;
  // Dwell on the final page runs to the end of the session, which the caller knows
  // from the replay metadata; without it, the last step gets no dwell at all.
  const end = opts.endTimestamp ?? last;
  const at = (timestamp: number) => Math.max(0, Math.round((timestamp - first) / 1000));
  const path = (row: TimelineRow) => text(row.pathname, MAX_PATH);

  // --- steps, with dwell from the gap to the next pageview ---
  const pageviews = ordered.filter(row => row.type === "pageview");
  const allSteps: DigestStep[] = pageviews.map((row, index) => {
    const next = pageviews[index + 1];
    return {
      path: path(row),
      at: at(row.timestamp),
      dwell: Math.max(0, Math.round(((next?.timestamp ?? end) - row.timestamp) / 1000)),
    };
  });
  const stepsTruncated = allSteps.length > MAX_STEPS;
  const steps: DigestStep[] = stepsTruncated
    ? [...allSteps.slice(0, MAX_STEPS / 2), ...allSteps.slice(-MAX_STEPS / 2)]
    : allSteps;

  // --- clicks, grouped by label on a page ---
  const clickRows = ordered.filter(row => row.type === "button_click");
  const clickGroups = new Map<string, DigestClick>();
  clickRows.forEach((row, index) => {
    const label = str(row.props, "text") || "(unlabelled)";
    const onPath = path(row);
    const key = `${onPath}\u0000${label}`;
    const existing = clickGroups.get(key);
    if (existing) existing.count += 1;
    else clickGroups.set(key, { label, path: onPath, count: 1, at: at(row.timestamp) });
  });
  const clicks = [...clickGroups.values()].sort((a, b) => b.count - a.count || a.at - b.at);

  // --- dead clicks: nothing happened after this one ---
  const submits = ordered.filter(row => row.type === "form_submit");
  const deadClicks = clickRows
    .filter(row => {
      const soon = (candidate: TimelineRow) => {
        const gap = candidate.timestamp - row.timestamp;
        return gap > 0 && gap < DEAD_CLICK_WINDOW_MS;
      };
      const moved = pageviews.some(soon);
      const submitted = submits.some(soon);
      return !moved && !submitted;
    })
    .reduce<DigestClick[]>((grouped, row, index) => {
      const label = str(row.props, "text") || "(unlabelled)";
      const onPath = path(row);
      const key = `${onPath}\u0000${label}`;
      const existing = grouped.find(entry => `${entry.path}\u0000${entry.label}` === key);
      if (existing) existing.count += 1;
      else grouped.push({ label, path: onPath, count: 1, at: at(row.timestamp) });
      return grouped;
    }, [])
    .sort((a, b) => b.count - a.count);

  // --- fields touched, named but never valued ---
  const fieldGroups = new Map<string, DigestField>();
  for (const row of ordered.filter(row => row.type === "input_change")) {
    const name = str(row.props, "inputName") || str(row.props, "element", 40) || "(unnamed field)";
    const kind = str(row.props, "inputType", 20) || str(row.props, "element", 20) || "field";
    const key = `${name}\u0000${kind}`;
    const existing = fieldGroups.get(key);
    if (existing) existing.count += 1;
    else fieldGroups.set(key, { name, kind, count: 1 });
  }

  // --- forms, and whether they were ever submitted ---
  const formGroups = new Map<string, DigestForm>();
  const formFor = (name: string) => {
    const key = name || "(unnamed form)";
    const existing = formGroups.get(key);
    if (existing) return existing;
    const created: DigestForm = { name: key, submitted: false, fields: [] };
    formGroups.set(key, created);
    return created;
  };
  for (const row of ordered) {
    if (row.type === "form_submit") {
      formFor(str(row.props, "formName")).submitted = true;
    }
    if (row.type === "input_change") {
      const form = formFor(str(row.props, "formName"));
      const field = str(row.props, "inputName");
      if (field && !form.fields.includes(field)) form.fields.push(field);
    }
  }

  // --- errors and custom events ---
  const errors = ordered.filter(row => row.type === "error").map(row => {
    const detail = str(row.props, "message", MAX_ERROR);
    const kind = str(row.props, "type", 40);
    return { message: detail || text(row.event_name, MAX_ERROR) || "error", kind, at: at(row.timestamp) };
  });

  const eventCounts = new Map<string, number>();
  for (const row of ordered.filter(row => row.type === "custom_event")) {
    const name = text(row.event_name, MAX_LABEL) || "(unnamed)";
    eventCounts.set(name, (eventCounts.get(name) ?? 0) + 1);
  }

  const outbound = [
    ...new Set(ordered.filter(row => row.type === "outbound").map(row => str(row.props, "domain", 80) || path(row))),
  ];

  return {
    truncated:
      stepsTruncated || clicks.length > MAX_ITEMS || fieldGroups.size > MAX_ITEMS || formGroups.size > MAX_ITEMS,
    ...(stepsTruncated ? { stepsTruncated: true } : {}),
    durationSeconds: Math.max(0, Math.round((end - first) / 1000)),
    entryPage: allSteps[0]?.path ?? "",
    exitPage: allSteps[allSteps.length - 1]?.path ?? "",
    steps,
    clicks: clicks.slice(0, MAX_ITEMS),
    deadClicks: deadClicks.slice(0, MAX_ITEMS),
    fields: [...fieldGroups.values()].sort((a, b) => b.count - a.count).slice(0, MAX_ITEMS),
    forms: [...formGroups.values()].slice(0, MAX_ITEMS),
    errors,
    customEvents: [...eventCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    outbound,
    totals: {
      pageviews: pageviews.length,
      clicks: clickRows.length,
      formSubmits: submits.length,
      fieldsTouched: count(ordered, "input_change"),
      errors: errors.length,
    },
  };
}

/** The prop names this digest is allowed to read, for the test that guards it. */
export const ALLOWED_PROPS = PROPS_ALLOWED;

/**
 * A digest rendered for the model.
 *
 * Keys are short and counts are pre-aggregated so a session costs a few hundred
 * tokens rather than a few thousand — the difference between being able to read
 * twenty sessions and being able to read two.
 */
export function digestForModel(digest: SessionDigest, sessionId: string) {
  return {
    session_id: sessionId,
    duration_seconds: digest.durationSeconds,
    entry_page: digest.entryPage,
    exit_page: digest.exitPage,
    path: digest.steps.map(step => `${step.path} (${step.dwell}s)`),
    clicks: digest.clicks.map(click => `${click.label} ×${click.count} on ${click.path}`),
    dead_clicks: digest.deadClicks.map(click => `${click.label} ×${click.count} on ${click.path}`),
    fields_touched: digest.fields.map(field => `${field.name} (${field.kind}) ×${field.count}`),
    forms: digest.forms.map(form => `${form.name}: ${form.submitted ? "submitted" : "NOT submitted"}, fields ${form.fields.join(", ") || "none"}`),
    errors: digest.errors.map(error => `${error.message}${error.kind ? ` (${error.kind})` : ""} at ${error.at}s`),
    custom_events: digest.customEvents.map(event => `${event.name} ×${event.count}`),
    outbound: digest.outbound,
    truncated: digest.truncated,
    ...(digest.stepsTruncated ? { journey_note: "Long journey: the first and last pages are shown, not every page." } : {}),
    ...(digest.eventsTruncated
      ? {
          events_truncated: true,
          note: "This session had more events than were read, so every count is a floor, not a total. Do not quote a count from this as an exact figure.",
        }
      : {}),
    totals: digest.totals,
  };
}
