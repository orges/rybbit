"use client";

import { AlertTriangle, Brain, Check, ChevronRight, Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import type { ToolCallView } from "@/api/analyst/endpoints/analyst";
import { cn } from "@/lib/utils";

/**
 * What the analyst is doing right now.
 *
 * PostHog's answer is only trustworthy if the user can see the ground it stands
 * on, so the tool trail is always visible rather than hidden behind a "thinking"
 * label: every query the model ran is a row, with its result, its duration, and
 * a way in to the SQL behind it.
 */

const TOOL_LABELS: Record<string, string> = {
  get_overview: "Read headline metrics",
  get_timeseries: "Read traffic over time",
  get_breakdown: "Break down a dimension",
  list_event_names: "List event names",
  get_event_properties: "Inspect event properties",
  get_errors: "Read error tracking",
  get_web_vitals: "Read web vitals",
  get_retention: "Read retention",
  get_funnel: "Read funnel",
  get_journeys: "Read journeys",
  search_replays: "Search session replays",
  run_sql: "Run a custom query",
  show_chart: "Draw a chart",
  show_table: "Show a table",
};

function ToolRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const t = useExtracted();
  const running = call.status === "running";
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : undefined;
  const sql = input && typeof input.sql === "string" ? input.sql : undefined;
  const detail = input
    ? Object.entries(input)
        .filter(([key, value]) => key !== "sql" && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length))
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
        .join(" · ")
    : "";

  return (
    <li className="text-xs">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
          open ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
        )}
        aria-expanded={open}
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-neutral-400" />
        ) : call.ok ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">{TOOL_LABELS[call.name] ?? call.name}</span>
        {call.summary && <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">{call.summary}</span>}
        {call.durationMs > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-neutral-400">{`${(call.durationMs / 1000).toFixed(1)}s`}</span>
        )}
        {detail && !call.summary && <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">{detail}</span>}
        <ChevronRight className={cn("size-3.5 shrink-0 text-neutral-400 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mx-1.5 mt-1 space-y-1 rounded-md border border-neutral-150 bg-neutral-50 p-2 text-[11px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          {sql && <pre className="overflow-x-auto whitespace-pre-wrap font-mono">{sql}</pre>}
          {!sql && detail && <p className="font-mono break-words">{detail}</p>}
          {call.summary && <p className="text-neutral-500 dark:text-neutral-400">{call.summary}</p>}
          {call.artifact && <p className="font-medium">{(call.artifact as { title: string }).title}</p>}
        </div>
      )}
    </li>
  );
}

export function ToolActivity({
  reasoning,
  toolCalls,
  running,
}: {
  reasoning?: string;
  toolCalls?: ToolCallView[];
  running?: boolean;
}) {
  const t = useExtracted();
  const [showReasoning, setShowReasoning] = useState(false);
  const calls = toolCalls ?? [];
  if (!reasoning && calls.length === 0 && !running) return null;

  return (
    <div className="space-y-1.5">
      {(reasoning || running) && (
        <div className="rounded-lg border border-neutral-150 bg-neutral-50/60 dark:border-neutral-850 dark:bg-neutral-900/60">
          <button
            type="button"
            onClick={() => setShowReasoning(value => !value)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-neutral-600 dark:text-neutral-300"
            aria-expanded={showReasoning}
          >
            {running ? <Loader2 className="size-3.5 animate-spin text-neutral-400" /> : <Brain className="size-3.5 text-neutral-400" />}
            {running ? t("Thinking…") : t("Reasoning")}
            <ChevronRight className={cn("ml-auto size-3.5 text-neutral-400 transition-transform", showReasoning && "rotate-90")} />
          </button>
          {(showReasoning || (running && !reasoning)) && reasoning && (
            <p className="px-2.5 pb-2 text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-500 dark:text-neutral-400">
              {reasoning}
            </p>
          )}
        </div>
      )}
      {calls.length > 0 && (
        <ul className="space-y-0.5">
          {calls.map(call => (
            <ToolRow key={call.id} call={call} />
          ))}
        </ul>
      )}
    </div>
  );
}
