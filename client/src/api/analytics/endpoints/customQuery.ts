import { authedFetch } from "../../utils";

export type CustomQueryRow = Record<string, unknown>;

export type RunCustomQueryResponse = {
  data: CustomQueryRow[];
  meta: {
    queryId: string;
    rowCount: number;
    maxExecutionTimeSeconds: number;
    maxRows: number;
  };
};

export type GenerateCustomQueryResponse = {
  query: string;
};

export type CustomQueryGenerationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type GenerateCustomQueryRequest = {
  prompt: string;
  currentSiteId?: number;
  currentPage?: string;
  currentQuery?: string;
  history?: CustomQueryGenerationMessage[];
};

export type AnalyzeQueryResponse = {
  query: string;
  summary: string;
  rows: CustomQueryRow[];
  rowCount: number;
};

export function analyzeQuery(
  organizationId: string,
  data: { query: string; question: string; siteId: number },
  signal?: AbortSignal
) {
  return authedFetch<AnalyzeQueryResponse>(`/organizations/${organizationId}/analytics/query/analyze`, undefined, {
    method: "POST",
    data,
    signal,
  });
}

export function runCustomQuery(organizationId: string, query: string, siteId?: number) {
  return authedFetch<RunCustomQueryResponse>(`/organizations/${organizationId}/analytics/query`, undefined, {
    method: "POST",
    data: { query, siteId },
  });
}

export function generateCustomQuery(organizationId: string, data: GenerateCustomQueryRequest, signal?: AbortSignal) {
  return authedFetch<GenerateCustomQueryResponse>(
    `/organizations/${organizationId}/analytics/query/generate`,
    undefined,
    {
      method: "POST",
      data,
      signal,
    }
  );
}
