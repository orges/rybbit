"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { useGetFunnels } from "@/api/analytics/hooks/funnels/useGetFunnels";
import { getDashboardTimeForRange } from "@/lib/defaultTimeRange";
import { useStore, useTimezone } from "@/lib/store";
import type { FunnelProposal } from "@/api/analyst/endpoints/suggest";
import { CopilotPanel } from "../../components/CopilotPanel";
import { CreateFunnelDialog } from "./CreateFunnel";

/**
 * The copilot on the Funnels page.
 *
 * Same contract as the Goals one: it proposes a sequence, shows why and what it
 * read, and hands the steps to the existing editor. Saving is the editor's button,
 * with its own validation behind it.
 */
export function FunnelCopilot({ siteId, organizationId }: { siteId: number; organizationId: string }) {
  const t = useExtracted();
  const { data } = useGetFunnels(siteId);
  const timeZone = useTimezone();
  const [draft, setDraft] = useState<{ proposal: FunnelProposal | null; open: boolean }>({ proposal: null, open: false });
  const existing = (data ?? []).map(funnel => funnel.name).filter(Boolean);

  return (
    <>
      <CopilotPanel<FunnelProposal>
        siteId={siteId}
        organizationId={organizationId}
        kind="funnel"
        existing={existing}
        askPlaceholder={t("Describe a journey, or leave empty for a suggestion")}
        revisePlaceholder={t("Say what to change about it")}
        loadingLabel={t("Looking at the pages and events this site actually has…")}
        actionLabel={t("Open in the editor")}
        render={proposal => (
          <>
            <p className="text-sm font-medium">{proposal.value.name || t("Suggested funnel")}</p>
            <ol className="space-y-0.5">
              {proposal.value.steps.map((step, index) => (
                <li key={index} className="truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                  {index + 1}. {step.type}: {step.value}
                </li>
              ))}
            </ol>
          </>
        )}
        onOpen={proposal => {
          // The editor's live preview reads the page's range, so a page sitting on
          // an hour shows zero sessions for a proposal that just looked over a
          // month, and looks broken.
          useStore.getState().setTime(getDashboardTimeForRange("last-7-days", timeZone));
          setDraft({ proposal, open: true });
        }}
      />
      {draft.proposal && (
        <CreateFunnelDialog
          open={draft.open}
          onOpenChange={open => setDraft({ proposal: null, open })}
          initial={draft.proposal.value}
        />
      )}
    </>
  );
}
