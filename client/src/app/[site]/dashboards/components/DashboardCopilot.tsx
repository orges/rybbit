"use client";

import { Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { DASHBOARD_EXAMPLES, type DashboardCard } from "@rybbit/shared";
import { useExtracted } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCreateDashboard } from "@/api/analytics/hooks/useDashboards";
import { suggest, type DashboardProposal, type SuggestionResult } from "@/api/analyst/endpoints/suggest";
import { getStartAndEndDate } from "@/api/utils";
import { Button } from "@/components/ui/button";
import { useStore, useTimezone } from "@/lib/store";
import { createCardFromExample } from "../utils";

/**
 * The copilot on the Dashboards page.
 *
 * It picks panels from the example gallery the card editor already shows, so
 * every card it builds is one a person could have built by clicking. Creating the
 * dashboard and adding the cards is the person's click: this only fills the
 * editor.
 */
export function DashboardCopilot({ siteId, organizationId }: { siteId: number; organizationId: string }) {
  const t = useExtracted();
  const router = useRouter();
  const time = useStore(state => state.time);
  const filters = useStore(state => state.filters);
  const timeZone = useTimezone();
  const createDashboard = useCreateDashboard();
  const [ask, setAsk] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestionResult<DashboardProposal> | null>(null);

  const { startDate, endDate } = getStartAndEndDate(time, timeZone);
  const proposal = result?.proposal ?? null;

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await suggest(organizationId, "dashboard", {
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

  /**
   * Creates the dashboard and hands the editor its cards.
   *
   * `createCardFromExample` is the editor's own builder, so the cards it produces
   * are laid out and sized exactly as if they had been added by hand.
   */
  const build = async () => {
    if (!proposal) return;
    const byId = new Map(DASHBOARD_EXAMPLES.map(example => [example.id, example]));
    const cards: DashboardCard[] = [];
    for (const [index, card] of proposal.value.cards.entries()) {
      const example = byId.get(card.exampleId);
      if (!example) continue;
      const built = createCardFromExample(index, cards, example);
      cards.push({ ...built, title: card.title || built.title });
    }
    const created = await createDashboard.mutateAsync({ siteId, name: proposal.value.name, config: { cards } });
    router.push(`/${siteId}/dashboards/${created.dashboardId}`);
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
            placeholder={t("Describe what to watch, or leave empty for a starter dashboard")}
            aria-label={t("Describe what to watch")}
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
          {t("Choosing panels from the example queries…")}
        </p>
      )}

      {result && !loading && (
        <div className="space-y-2 rounded-lg border border-neutral-150 bg-white p-3 dark:border-neutral-850 dark:bg-neutral-900">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">{proposal?.value.name || t("Suggested dashboard")}</p>
              {proposal && (
                <ul className="space-y-0.5">
                  {proposal.value.cards.map(card => (
                    <li key={card.exampleId} className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                      {card.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="smIcon"
              aria-label={t("Dismiss")}
              onClick={() => {
                setResult(null);
                setAsk("");
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          {result.reason && <p className="text-xs text-neutral-600 dark:text-neutral-300">{result.reason}</p>}

          {proposal ? (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" disabled={createDashboard.isPending} onClick={() => void build()}>
                {t("Build it")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => void run()}>
                {t("Suggest another")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
