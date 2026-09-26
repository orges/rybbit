"use client";

import { Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { suggestGoal, type SuggestionResult } from "@/api/analyst/endpoints/suggest";
import { getStartAndEndDate } from "@/api/utils";
import { Button } from "@/components/ui/button";
import { useStore, useTimezone } from "@/lib/store";
import GoalFormModal from "./GoalFormModal";

/**
 * The copilot on the Goals page.
 *
 * It proposes a goal and then gets out of the way: the proposal is shown with the
 * reasoning and what it looked at, and "Open in the form" hands the value to the
 * same form a person fills in by hand. Nothing is saved here, so a wrong
 * suggestion costs a click rather than a delete.
 */

type Proposed = NonNullable<SuggestionResult["proposal"]>;

export function GoalCopilot({ siteId, organizationId }: { siteId: number; organizationId: string }) {
  const t = useExtracted();
  const time = useStore(state => state.time);
  const filters = useStore(state => state.filters);
  const timeZone = useTimezone();
  const [ask, setAsk] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestionResult | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { startDate, endDate } = getStartAndEndDate(time, timeZone);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await suggestGoal(organizationId, {
          siteId,
          ...(ask.trim() ? { ask: ask.trim() } : {}),
          context: {
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
            timeZone,
            filters,
          },
        })
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not get a suggestion"));
    } finally {
      setLoading(false);
    }
  };

  const proposal = result?.proposal ?? null;
  const dismiss = () => {
    setResult(null);
    setAsk("");
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-neutral-150 bg-white px-2 py-1.5 focus-within:ring-1 focus-within:ring-neutral-400 dark:border-neutral-800 dark:bg-neutral-950">
          <Sparkles className="size-3.5 shrink-0 text-neutral-400" />
          <input
            value={ask}
            onChange={event => setAsk(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void run();
              }
            }}
            maxLength={300}
            placeholder={t("Describe what to track, or leave empty for a suggestion")}
            aria-label={t("Describe what to track")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
          />
        </div>
        <Button type="button" size="sm" disabled={loading} onClick={() => void run()}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {t("Suggest")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {loading && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {t("Looking at the pages and events this site actually has…")}
        </p>
      )}

      {result && !loading && (
        <div className="space-y-2 rounded-lg border border-neutral-150 bg-white p-3 dark:border-neutral-850 dark:bg-neutral-900">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">{proposal?.value.name || t("Suggested goal")}</p>
              <p className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                {proposal?.value.goalType}
                {proposal?.value.config?.pathPattern ? ` · ${String(proposal.value.config.pathPattern)}` : ""}
                {proposal?.value.config?.eventName ? ` · ${String(proposal.value.config.eventName)}` : ""}
                {proposal?.value.config?.valuePattern ? ` · ${String(proposal.value.config.valuePattern)}` : ""}
              </p>
            </div>
            <Button type="button" variant="ghost" size="smIcon" aria-label={t("Dismiss")} onClick={dismiss}>
              <X className="size-3.5" />
            </Button>
          </div>

          {result.reason && <p className="text-xs text-neutral-600 dark:text-neutral-300">{result.reason}</p>}

          {result.looked?.length ? (
            <details>
              <summary className="cursor-pointer text-[11px] text-neutral-500 dark:text-neutral-400">
                {t("What it looked at")}
              </summary>
              <ul className="mt-1 space-y-0.5">
                {result.looked.map((call, index) => (
                  <li key={index} className="truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                    {call.name}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {proposal ? (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={() => setShowForm(true)}>
                {t("Open in the form")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => void run()}>
                {t("Suggest another")}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {proposal && (
        <GoalFormModal
          siteId={siteId}
          open={showForm}
          onOpenChange={next => {
            setShowForm(next);
            // Saved or not, the proposal has been dealt with; asking again
            // should not reoffer the same one.
            if (!next) dismiss();
          }}
          initialGoal={proposal.value}
        />
      )}
    </div>
  );
}
