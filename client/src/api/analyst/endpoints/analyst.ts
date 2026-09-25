import type { Filter } from "@rybbit/shared";
import { authedFetch } from "../../utils";
import { BACKEND_URL } from "../../../lib/const";

export type AnalystArtifact =
  | {
      type: "chart";
      title: string;
      chartType: "bar" | "line" | "area" | "donut";
      dimension: string;
      metric: string;
      points: Array<{ label: string; value: number; series?: string }>;
      /** The analytics tool that produced the rows, so the result can link to the page that owns it. */
      source?: string;
    }
  | { type: "table"; title: string; columns: string[]; rows: string[][]; total: number; truncated: boolean; source?: string }
  | { type: "followups"; title: string; options: string[] }
  | { type: "sql"; title: string; sql: string; rowCount: number };

export interface ToolCallView {
  id: string;
  name: string;
  input?: unknown;
  ok: boolean;
  summary: string;
  durationMs: number;
  artifact?: AnalystArtifact;
  status?: "running" | "done" | "error";
}

export interface MessageContext {
  startDate?: string;
  endDate?: string;
  rangeLabel?: string;
  timeZone?: string;
  filters?: Filter[];
  page?: string;
  stat?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallView[];
  artifacts?: AnalystArtifact[];
  context?: MessageContext;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  stopped?: boolean;
  /** Figures in the answer that no tool result contained. */
  unverified?: string[];
  pending?: boolean;
  error?: string;
  rating?: number;
  createdAt?: string;
}

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "text_discard"; chars: number }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string; durationMs: number; artifact?: AnalystArtifact }
  | { type: "artifact"; artifact: AnalystArtifact }
  | { type: "usage"; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
  | { type: "title"; title: string }
  | { type: "unverified"; figures: string[] }
  | { type: "message_id"; messageId: string }
  | { type: "done"; stopped: boolean; steps: number }
  | { type: "error"; message: string; retryable: boolean };

export interface SendMessageRequest {
  siteId: number;
  message: string;
  conversationId?: string;
  regenerate?: boolean;
  context?: MessageContext;
}

export type ConversationSummary = { id: string; title: string; updatedAt: string; snippet?: string };

export type ConversationDetail = { id: string; title: string; messages: ChatMessage[] };

const conversationsUrl = (organizationId: string) => `/organizations/${organizationId}/analytics/conversations`;

export function listConversations(organizationId: string, siteId: number, search?: string) {
  return authedFetch<ConversationSummary[]>(`${conversationsUrl(organizationId)}`, { siteId, ...(search ? { search } : {}) });
}

export function getConversation(organizationId: string, siteId: number, id: string) {
  return authedFetch<ConversationDetail>(`${conversationsUrl(organizationId)}/${id}`, { siteId });
}

export function renameConversation(organizationId: string, siteId: number, id: string, title: string) {
  return authedFetch<ConversationSummary>(`${conversationsUrl(organizationId)}/${id}`, { siteId }, { method: "PATCH", data: JSON.stringify({ title }) });
}

export function deleteConversation(organizationId: string, siteId: number, id: string) {
  return authedFetch<{ success: true }>(`${conversationsUrl(organizationId)}/${id}`, { siteId }, { method: "DELETE" });
}

export function sendFeedback(organizationId: string, body: { siteId: number; messageId: string; rating: number; comment?: string }) {
  return authedFetch<{ success: true }>(`/organizations/${organizationId}/analytics/feedback`, undefined, { method: "POST", data: JSON.stringify(body) });
}

export function listMemories(organizationId: string, siteId: number) {
  return authedFetch<Array<{ id: string; content: string; createdAt: string }>>(`/organizations/${organizationId}/analytics/memories`, { siteId });
}

export function addMemory(organizationId: string, siteId: number, content: string) {
  return authedFetch<{ id: string }>(`/organizations/${organizationId}/analytics/memories`, { siteId }, { method: "POST", data: JSON.stringify({ siteId, content }) });
}

export function deleteMemory(organizationId: string, siteId: number, id: string) {
  return authedFetch<{ success: true }>(`/organizations/${organizationId}/analytics/memories/${id}`, { siteId }, { method: "DELETE" });
}

const decoder = new TextDecoder();

/**
 * Reads the analyst's SSE stream and hands each event to `onEvent`.
 *
 * The stream is the only source of truth for a turn: text, reasoning, tool
 * activity, artifacts and usage all arrive as the run happens, so the UI never
 * has to poll a message it is already receiving.
 */
export async function streamAnalystMessage(
  organizationId: string,
  body: SendMessageRequest,
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent) => void
) {
  const response = await fetch(`${BACKEND_URL}/organizations/${organizationId}/analytics/chat`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `The analyst is unavailable (${response.status})`);
  }
  if (!response.body) throw new Error("The analyst stream is unavailable");

  const reader = response.body.getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = frame.split("\n").find(entry => entry.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)) as ChatStreamEvent);
    }
    if (done) return;
  }
}
