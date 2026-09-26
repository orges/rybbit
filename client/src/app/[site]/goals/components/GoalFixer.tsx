"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import type { GoalProposal } from "@/api/analyst/endpoints/suggest";
import type { Goal } from "../../../../api/analytics/endpoints";
import { CopilotPanel } from "../../components/CopilotPanel";
import GoalFormModal from "./GoalFormModal";

/**
 * The copilot on a goal that matched nothing.
 *
 * A goal with zero conversions is not a report, it is a question the person
 * cannot answer from the page: the pattern is wrong, or the event never fired, or
 * the range is too short. This asks the model to look at what the site actually
 * does instead, and offers a replacement the person can open in the form.
 *
 * The dead goal is on the list of things not to propose — otherwise "what should
 * I track instead" is answered with the thing that does not work.
 */
export function GoalFixer({ siteId, organizationId, goal }: { siteId: number; organizationId: string; goal: Goal }) {
  const t = useExtracted();
  const [proposal, setProposal] = useState<GoalProposal | null>(null);
  const [open, setOpen] = useState(false);
  const pattern = goal.goalType === "path" ? goal.config.pathPattern : goal.goalType === "event" ? goal.config.eventName : goal.config.valuePattern;

  return (
    <>
      <CopilotPanel<GoalProposal>
        siteId={siteId}
        organizationId={organizationId}
        kind="goal"
        existing={[{ ...(goal.name ? { name: goal.name } : {}), condition: pattern || goal.goalType }]}
        // Matches the banner above it: the number on the card is the selected
        // range, so the ask cannot claim a window the person is not looking at.
        initialAsk={t("This goal matched nothing in the selected range. What does this site actually do that I should be tracking instead?")}
        askPlaceholder={t("Describe what to track instead")}
        revisePlaceholder={t("Say what to change about it")}
        loadingLabel={t("Looking at the pages and events this site actually has…")}
        actionLabel={t("Open in the form")}
        render={draft => (
          <>
            <p className="text-sm font-medium">{draft.value.name || t("Suggested goal")}</p>
            <p className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
              {draft.value.goalType}
              {draft.value.config?.pathPattern ? ` · ${String(draft.value.config.pathPattern)}` : ""}
              {draft.value.config?.eventName ? ` · ${String(draft.value.config.eventName)}` : ""}
              {draft.value.config?.valuePattern ? ` · ${String(draft.value.config.valuePattern)}` : ""}
            </p>
          </>
        )}
        onOpen={draft => {
          setProposal(draft);
          setOpen(true);
        }}
      />
      {proposal && (
        <GoalFormModal
          siteId={siteId}
          open={open}
          onOpenChange={setOpen}
          initialGoal={proposal.value}
        />
      )}
    </>
  );
}
