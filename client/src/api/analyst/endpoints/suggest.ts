import { authedFetch } from "../../utils";
import type { FunnelStep } from "../../analytics/endpoints";

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

export interface DashboardProposal {
  kind: "dashboard";
  value: { name: string; cards: Array<{ exampleId: string; title: string; vizType: string; category: string }> };
  reason: string;
}

export type AnyProposal = GoalProposal | FunnelProposal | DashboardProposal;

/** What the copilot looked at before proposing, so the reasoning is checkable. */
export interface SuggestionResult<T> {
  proposal: T | null;
  /** The model's own words when it had no proposal to make. */
  reason: string;
  looked?: Array<{ name: string; input: unknown }>;
}

/** The proposal a revision acts on, sent back so "make it three steps" works. */
export interface PreviousProposal {
  value: Record<string, unknown>;
  reason: string;
  ask?: string;
}

export interface SuggestRequest {
  siteId: number;
  ask?: string;
  previous?: PreviousProposal;
  context?: {
    startDate?: string;
    endDate?: string;
    rangeLabel?: string;
    timeZone?: string;
    filters?: unknown[];
    /** What the page already tracks, as name and condition. */
    existing?: Array<{ name?: string; condition: string }>;
  };
}

export type SuggestKind = "goal" | "funnel" | "dashboard";

const endpoint = (organizationId: string) => `/organizations/${organizationId}/analytics/suggest`;

/** The kind-agnostic call, for a panel that renders whatever it is given. */
export function suggestAny(organizationId: string, kind: SuggestKind, body: SuggestRequest) {
  return authedFetch<SuggestionResult<AnyProposal>>(endpoint(organizationId), undefined, {
    method: "POST",
    // The object, not a string: axios only sets the JSON content type for one,
    // and the backend answers 415 for a body it cannot parse.
    data: { kind, ...body },
  });
}

export function suggest(organizationId: string, kind: "goal", body: SuggestRequest): Promise<SuggestionResult<GoalProposal>>;
export function suggest(
  organizationId: string,
  kind: "funnel",
  body: SuggestRequest
): Promise<SuggestionResult<FunnelProposal>>;
export function suggest(
  organizationId: string,
  kind: "dashboard",
  body: SuggestRequest
): Promise<SuggestionResult<DashboardProposal>>;
export function suggest(organizationId: string, kind: "goal" | "funnel" | "dashboard", body: SuggestRequest) {
  return suggestAny(organizationId, kind, body);
}
