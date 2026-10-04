"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { useGetGoals } from "@/api/analytics/hooks/goals/useGetGoals";
import type { GoalProposal } from "@/api/analyst/endpoints/suggest";
import { CopilotPanel } from "../../components/CopilotPanel";
import { GoalEditor } from "./GoalEditor";
import { goalFormValuesOf } from "../utils/goalForm";

/**
 * The copilot on the Goals page.
 *
 * It proposes a goal and gets out of the way: "Open in the form" fills the
 * ledger's own editor, and nothing is written here.
 */
export function GoalCopilot({ siteId, organizationId }: { siteId: number; organizationId: string }) {
  const t = useExtracted();
  const { data } = useGetGoals({ page: 1, pageSize: 50 });
  const [initial, setInitial] = useState<ReturnType<typeof goalFormValuesOf> | null>(null);

  /**
   * What the page already tracks, named *and* spelled out.
   *
   * The condition is what makes two goals the same goal, so a name alone is not
   * enough: a list of names and a model asked not to repeat them produces the same
   * /search goal under a fresh title, which is worse than no check at all.
   */
  const existing = (data?.data ?? []).map(goal => ({
    ...(goal.name ? { name: goal.name } : {}),
    condition: goal.config?.pathPattern || goal.config?.eventName || goal.config?.valuePattern || goal.goalType,
  }));

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
        onOpen={proposal => setInitial(goalFormValuesOf(proposal.value))}
      />
      {initial && <GoalEditor siteId={siteId} mode="create" initial={initial} onDone={() => setInitial(null)} />}
    </>
  );
}
