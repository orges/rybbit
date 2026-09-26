import { authedFetch } from "../../utils";

/**
 * A copilot proposal: a value for a form the product already has, plus why.
 *
 * Nothing is saved. The page fills its own form from `value` and a person presses
 * the same save button they would have pressed anyway.
 */
export interface SuggestionResult {
  proposal: {
    kind: "goal";
    value: { name?: string; goalType: string; config?: Record<string, unknown> };
    reason: string;
  } | null;
  /** The model's own words when it had no proposal to make. */
  reason: string;
  looked?: Array<{ name: string; input: unknown }>;
}

export function suggestGoal(organizationId: string, body: SuggestGoalRequest) {
  return authedFetch<SuggestionResult>(`/organizations/${organizationId}/analytics/suggest`, undefined, {
    method: "POST",
    data: JSON.stringify({ kind: "goal", ...body }),
  });
}

export interface SuggestGoalRequest {
  siteId: number;
  ask?: string;
  context?: {
    startDate?: string;
    endDate?: string;
    rangeLabel?: string;
    timeZone?: string;
    filters?: unknown[];
  };
}
