"use client";

import { useExtracted } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCreateDashboard, useGetDashboards } from "@/api/analytics/hooks/useDashboards";
import { DASHBOARD_EXAMPLES, type DashboardCard } from "@rybbit/shared";
import type { DashboardProposal } from "@/api/analyst/endpoints/suggest";
import { getDashboardTimeForRange } from "@/lib/defaultTimeRange";
import { useStore, useTimezone } from "@/lib/store";
import { CopilotPanel } from "../../components/CopilotPanel";
import { createCardFromExample } from "../utils";

/**
 * The copilot on the Dashboards page.
 *
 * It picks panels from the example gallery the card editor already shows, so
 * every card it builds is one a person could have built by clicking. Creating the
 * dashboard is the button in the proposal card, and the person presses it.
 */
export function DashboardCopilot({ siteId, organizationId }: { siteId: number; organizationId: string }) {
  const t = useExtracted();
  const router = useRouter();
  const timeZone = useTimezone();
  const createDashboard = useCreateDashboard();
  const { data: dashboards } = useGetDashboards(siteId);
  const [pending, setPending] = useState(false);
  const existing = (dashboards ?? []).map(dashboard => ({ name: dashboard.name, condition: dashboard.name }));

  /** Creates the dashboard and hands the editor its cards. */
  const build = async (proposal: DashboardProposal) => {
    const byId = new Map(DASHBOARD_EXAMPLES.map(example => [example.id, example]));
    const cards: DashboardCard[] = [];
    for (const [index, card] of proposal.value.cards.entries()) {
      const example = byId.get(card.exampleId);
      if (!example) continue;
      const built = createCardFromExample(index, cards, example);
      cards.push({ ...built, title: card.title || built.title });
    }
    layout(cards);
    setPending(true);
    try {
      // The proposal looked over a month, so a dashboard opening on an hour reads
      // as empty. Open it on a week: the range a dashboard is normally read at.
      useStore.getState().setTime(getDashboardTimeForRange("last-7-days", timeZone));
      const created = await createDashboard.mutateAsync({ siteId, name: proposal.value.name, config: { cards } });
      router.push(`/${siteId}/dashboards/${created.dashboardId}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <CopilotPanel<DashboardProposal>
      siteId={siteId}
      organizationId={organizationId}
      kind="dashboard"
      existing={existing}
      askPlaceholder={t("Describe what to watch, or leave empty for a starter dashboard")}
      revisePlaceholder={t("Say what to change about it")}
      loadingLabel={t("Choosing panels from the example queries…")}
      actionLabel={pending ? t("Building…") : t("Build it")}
      render={proposal => (
        <>
          <p className="text-sm font-medium">{proposal.value.name || t("Suggested dashboard")}</p>
          <ul className="space-y-0.5">
            {proposal.value.cards.map(card => (
              <li key={card.exampleId} className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                {card.title}
              </li>
            ))}
          </ul>
        </>
      )}
      onOpen={proposal => void build(proposal)}
    />
  );
}

/**
 * Flows cards left to right across the 12-column grid, wrapping when a row is
 * full and carrying the tallest card's height into the next row.
 *
 * The editor stacks hand-added cards at x: 0, which is right while you are
 * adding one at a time and wrong for a proposed dashboard: five cards would
 * arrive as one tall strip instead of something read at a glance.
 */
function layout(cards: DashboardCard[]) {
  const GRID = 12;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const card of cards) {
    const w = Math.min(card.gridPos.w || 6, GRID);
    if (x + w > GRID) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    card.gridPos = { x, y, w, h: card.gridPos.h || 5 };
    x += w;
    rowHeight = Math.max(rowHeight, card.gridPos.h);
  }
  return cards;
}
