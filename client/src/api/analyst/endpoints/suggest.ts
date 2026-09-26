import type { FunnelStep } from "../../analytics/endpoints";
import { authedFetch } from "../../utils";

/**
 * A copilot proposal: a value for a form the product already has, plus why.
 *
 * Nothing is saved. The page fills its own form from `value` and a person presses
 * the same save button they would have pressed anyway.
 */
export interface GoalProposal {
  kind: "goal";
  value: { name?: string; goalType: string; config?: Record<string, unknown> };
  reason: string;
}

export interface FunnelProposal {
  kind: "funnel";
  value: { name: string; steps: FunnelStep[] };
  reason: string;
}

/** What the copilot looked at before proposing, so the reasoning is checkable. */
export interface SuggestionResult<T> {
  proposal: T | null;
  /** The model's own words when it had no proposal to make. */
  reason: string;
  looked?: Array<{ name: string; input: unknown }>;
}

export interface SuggestRequest {
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

const endpoint = (organizationId: string) => `/organizations/${organizationId}/analytics/suggest`;

export function suggest(organizationId: string, kind: "goal", body: SuggestRequest): Promise<SuggestionResult<GoalProposal>>;
export function suggest(organizationId: string, kind: "funnel", body: SuggestRequest): Promise<SuggestionResult<FunnelProposal>>;
export function suggest(organizationId: string, kind: "goal" | "funnel", body: SuggestRequest) {
  return authedFetch<SuggestionResult<GoalProposal | FunnelProposal>>(endpoint(organizationId), undefined, {
    method: "POST",
    // The object, not a string: axios only sets the JSON content type for one,
    // and the backend answers 415 for a body it cannot parse.
    data: { kind, ...body },
  });
}
