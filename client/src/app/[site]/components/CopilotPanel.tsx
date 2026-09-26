"use client";

import { Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useState } from "react";
import {
  suggestAny,
  type AnyProposal,
  type PreviousProposal,
  type SuggestionResult,
  type SuggestKind,
} from "@/api/analyst/endpoints/suggest";
import { getStartAndEndDate } from "@/api/utils";
import { Button } from "@/components/ui/button";
import { useStore, useTimezone } from "@/lib/store";
import { describeInput } from "./describeToolInput";

/**
 * The copilot shell every page's copilot is built on.
 *
 * One place for the parts that must behave the same everywhere: it is a
 * conversation rather than a button, so a second request carries the proposal it
 * revises; it sends what the page already lists, so a duplicate is never
 * proposed; and it shows the evidence in words rather than tool names.
 *
 * What each page adds is the proposal itself and the button that hands it to a
 * form — the save is always the product's own.
 */
export function CopilotPanel<T extends AnyProposal>({
  siteId,
  organizationId,
  kind,
  askPlaceholder,
  revisePlaceholder,
  loadingLabel,
  actionLabel,
  existing = [],
  render,
  onOpen,
}: {
  siteId: number;
  organizationId: string;
  kind: SuggestKind;
  askPlaceholder: string;
  revisePlaceholder: string;
  loadingLabel: string;
  /** The button that hands the proposal to a form. */
  actionLabel: string;
  /** What the page already tracks, as name and condition. */
  existing?: Array<{ name?: string; condition: string }>;
  render: (proposal: T) => ReactNode;
  onOpen: (proposal: T) => void;
}) {
  const t = useExtracted();
  const time = useStore(state => state.time);
  const filters = useStore(state => state.filters);
  const timeZone = useTimezone();
  const [ask, setAsk] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestionResult<T> | null>(null);
  /** The last proposal, so the next request can revise it. */
  const [previous, setPrevious] = useState<PreviousProposal | null>(null);
  /** The instruction that produced it, for the same reason. */
  const [previousAsk, setPreviousAsk] = useState("");

  const { startDate, endDate } = getStartAndEndDate(time, timeZone);
  const proposal = result?.proposal ?? null;

  const run = async (instruction: string) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const next = await suggestAny(organizationId, kind, {
        siteId,
        ...(instruction.trim() ? { ask: instruction.trim() } : {}),
        ...(previous ? { previous: { ...previous, ...(previousAsk ? { ask: previousAsk } : {}) } } : {}),
        context: {
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          timeZone,
          filters,
          existing,
        },
      });
      setResult(next as SuggestionResult<T>);
      if (next.proposal) {
        setPrevious({ value: next.proposal.value as Record<string, unknown>, reason: next.reason });
        setPreviousAsk(instruction);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not get a suggestion"));
    } finally {
      setLoading(false);
    }
  };

  const dismiss = () => {
    setResult(null);
    setAsk("");
    setPrevious(null);
    setPreviousAsk("");
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
                void run(ask);
              }
            }}
            maxLength={300}
            placeholder={previous ? revisePlaceholder : askPlaceholder}
            aria-label={previous ? revisePlaceholder : askPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
          />
        </div>
        <Button type="button" size="sm" disabled={loading} onClick={() => void run(ask)}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {previous ? t("Revise") : t("Suggest")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {loading && <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{loadingLabel}</p>}

      {result && !loading && (
        <div className="space-y-2 rounded-lg border border-neutral-150 bg-white p-3 dark:border-neutral-850 dark:bg-neutral-900">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              {proposal ? render(proposal) : <p className="text-sm font-medium">{t("Suggestion")}</p>}
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
              {/* What it read, in words: a breakdown *by pathname* tells you whether
                  to trust a proposal, where a tool name does not. */}
              <ul className="mt-1 space-y-0.5">
                {result.looked.map((call, index) => {
                  const described = describeInput((call.input ?? null) as Record<string, unknown> | undefined);
                  return (
                    <li key={index} className="truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                      {call.name}
                      {described ? ` · ${described}` : ""}
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}

          {proposal && (
            <Button type="button" size="sm" onClick={() => onOpen(proposal)}>
              {actionLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
