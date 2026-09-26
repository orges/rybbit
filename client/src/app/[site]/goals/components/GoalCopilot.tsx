"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { useGetGoals } from "@/api/analytics/hooks/goals/useGetGoals";
import type { GoalProposal } from "@/api/analyst/endpoints/suggest";
import { CopilotPanel } from "../../components/CopilotPanel";
import GoalFormModal from "./GoalFormModal";

/**
 * The copilot on the Goals page.
 *
 * It proposes a goal and gets out of the way: "Open in the form" hands the value
 * to the same form a person fills in by hand, and nothing is written here.
 */
export function GoalCopilot({ siteId, organizationId }: { siteId: number; organizationId: string }) {
  const t = useExtracted();
  const { data } = useGetGoals({ page: 1, pageSize: 50 });
  const [draft, setDraft] = useState<{ proposal: GoalProposal | null; open: boolean }>({ proposal: null, open: false });

  /**
   * What the page already tracks, named *and* spelled out.
   *
   * The condition is what makes two goals the same goal, so a name alone is not
   * enough: a list of names and a model asked not to repeat them produces the same
   * /search goal under a fresh title, which is worse than no check at all.
   */
  const existing = (data?.data ?? []).map(goal => {
    const condition = goal.config?.pathPattern || goal.config?.eventName || goal.config?.valuePattern || goal.goalType;
    return goal.name ? `${goal.name} — ${condition}` : condition;
  });

  return (
    <>
      <CopilotPanel<GoalProposal>
        siteId={siteId}
        organizationId={organizationId}
        kind="goal"
        existing={existing}
        askPlaceholder={t("Describe what to track, or leave empty for a suggestion")}
        revisePlaceholder={t("Say what to change about it")}
        loadingLabel={t("Looking at the pages and events this site actually has…")}
        actionLabel={t("Open in the form")}
        render={proposal => (
          <>
            <p className="text-sm font-medium">{proposal.value.name || t("Suggested goal")}</p>
            <p className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
              {proposal.value.goalType}
              {proposal.value.config?.pathPattern ? ` · ${String(proposal.value.config.pathPattern)}` : ""}
              {proposal.value.config?.eventName ? ` · ${String(proposal.value.config.eventName)}` : ""}
              {proposal.value.config?.valuePattern ? ` · ${String(proposal.value.config.valuePattern)}` : ""}
            </p>
          </>
        )}
        onOpen={proposal => setDraft({ proposal, open: true })}
      />
      {draft.proposal && (
        <GoalFormModal
          siteId={siteId}
          open={draft.open}
          onOpenChange={open => {
            setDraft({ proposal: null, open });
          }}
          initialGoal={draft.proposal.value}
        />
      )}
    </>
  );
}
