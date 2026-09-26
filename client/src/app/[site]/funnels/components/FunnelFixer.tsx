"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import type { FunnelProposal } from "@/api/analyst/endpoints/suggest";
import { useGetSite } from "@/api/admin/hooks/useSites";
import { useStore } from "@/lib/store";
import { CopilotPanel } from "../../components/CopilotPanel";
import { CreateFunnelDialog } from "./CreateFunnel";
import type { SavedFunnel } from "../../../../api/analytics/endpoints";

/**
 * The copilot on a funnel that nothing enters.
 *
 * Zero sessions at step one is the one funnel failure a person cannot see the
 * cause of from the page: the chart is empty from the top, and the reason is
 * usually a step that never matches — a path that moved, an event that is
 * autocaptured under a different name, a step ordered after the one it should
 * follow. This asks what the site actually does and offers a sequence that
 * would.
 *
 * The dead funnel is on the list of things not to propose, so the answer cannot
 * be the thing that does not work.
 */
export function FunnelFixer({ funnel }: { funnel: SavedFunnel }) {
  const t = useExtracted();
  const site = useStore(state => state.site);
  const { data: siteData } = useGetSite(site);
  const organizationId = siteData?.organizationId;
  const [draft, setDraft] = useState<{ proposal: FunnelProposal | null; open: boolean }>({ proposal: null, open: false });
  const first = funnel.steps?.[0];

  if (!site || !organizationId || !first) return null;

  return (
    <>
      <CopilotPanel<FunnelProposal>
        siteId={Number(site)}
        organizationId={organizationId}
        kind="funnel"
        existing={[
          {
            ...(funnel.name ? { name: funnel.name } : {}),
            condition: funnel.steps.map(step => `${step.type}:${step.value}`).join(" > "),
          },
        ]}
        initialAsk={t("Nothing enters this funnel at its first step. What journey does this site actually have that I could measure?")}
        askPlaceholder={t("Describe the journey instead")}
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
        onOpen={proposal => setDraft({ proposal, open: true })}
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
