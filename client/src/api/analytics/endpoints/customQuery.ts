import { authedFetch } from "../../utils";
import { BACKEND_URL } from "../../../lib/const";

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
  conversationId?: string | null;
  query: string;
  summary: string;
  rows: CustomQueryRow[];
  rowCount: number;
  artifact?: AnalysisArtifact;
};

export type AiConversation = { id: string; title: string; updatedAt: string };
export type AnalysisDisplay = "none" | "table" | "bar" | "line" | "donut";
export type AnalysisArtifact =
  | { type: "table"; title: string; columns: string[]; rows: string[][] }
  | {
      type: "chart";
      title: string;
      chartType: "bar" | "line" | "donut";
      metric?: string;
      points: { label: string; value: number; series?: string }[];
    }
  | { type: "form"; question: string; options: string[] };

export function parseAnalysisSummary(summary: string): {
  display: AnalysisDisplay;
  text: string;
  artifact?: AnalysisArtifact;
} {
  const marker = /^<!--rybbit-artifact:(\{[^\n]*\})-->\n/.exec(summary);
  let artifact: AnalysisArtifact | undefined;
  if (marker) {
    try {
      artifact = JSON.parse(marker[1]) as AnalysisArtifact;
    } catch {
      /* Old or malformed metadata: show the answer. */
    }
    summary = summary.slice(marker[0].length);
  }
  const prefix = /^\[display:(none|table|bar|line|donut)\]\r?\n/i.exec(summary);
  if (prefix)
    return {
      display: prefix[1].toLowerCase() as AnalysisDisplay,
      text: summary.slice(prefix[0].length),
      ...(artifact ? { artifact } : {}),
    };
  return {
    display: "none",
    text: summary.startsWith("[display:") && !summary.includes("\n") ? "" : summary,
    ...(artifact ? { artifact } : {}),
  };
}
export type SavedAiExchange = {
  question: string;
  query: string;
  summary: string;
  rows: CustomQueryRow[];
  rowCount: number;
};

export function listAiConversations(organizationId: string, siteId: number, signal?: AbortSignal) {
  return authedFetch<AiConversation[]>(
    `/organizations/${organizationId}/analytics/conversations`,
    { siteId },
    { signal }
  );
}

export function getAiConversation(organizationId: string, siteId: number, id: string, signal?: AbortSignal) {
  return authedFetch<SavedAiExchange[]>(
    `/organizations/${organizationId}/analytics/conversations/${id}`,
    { siteId },
    { signal }
  );
}

export function deleteAiConversation(organizationId: string, siteId: number, id: string) {
  return authedFetch(
    `/organizations/${organizationId}/analytics/conversations/${id}`,
    { siteId },
    { method: "DELETE" }
  );
}

export async function analyzeQuery(
  organizationId: string,
  data: { query: string; question: string; siteId: number; conversationId?: string },
  signal: AbortSignal,
  onProgress: (result: AnalyzeQueryResponse) => void
): Promise<AnalyzeQueryResponse> {
  const response = await fetch(`${BACKEND_URL}/organizations/${organizationId}/analytics/query/analyze`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(data),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Analysis failed (${response.status})`);
  }
  if (!response.body) throw new Error("Analysis stream is unavailable");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalyzeQueryResponse | undefined;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = frame.split("\n").find(line => line.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "error") throw new Error(event.error || "Analysis failed");
        if (event.type === "result")
          result = { query: event.query, rows: event.rows, rowCount: event.rowCount, summary: "" };
        if (event.type === "delta" && result && typeof event.text === "string")
          result = { ...result, summary: result.summary + event.text };
        if (event.type === "artifact" && result) result = { ...result, artifact: event.artifact };
        if (event.type === "done") {
          complete = true;
          if (result) result = { ...result, conversationId: event.conversationId };
        }
        if (result) onProgress(result);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!complete || !result?.summary.trim()) throw new Error("Analysis stream ended before the summary was complete");
  return result;
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
