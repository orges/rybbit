import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db/postgres/postgres.js";
import { aiConversations, aiFeedback, aiMemories, aiMessages, aiRuns } from "../../../db/postgres/schema.js";
import type { Artifact } from "./presentation.js";
import type { ToolCallRecord } from "./agent.js";

/**
 * Durable state for the analyst.
 *
 * A conversation is a transcript, not a cache: reopening one replays the same
 * messages, tool cards and artifacts the user saw, with no analytics re-queried.
 * Only what the user saw is stored — the prose, the rendered artifact and a
 * summary of each tool call. Raw ClickHouse rows stay out of Postgres.
 */

export interface AssistantParts {
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  artifacts?: Artifact[];
  model?: string;
  steps?: number;
  stopped?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface UserParts {
  context?: {
    startDate?: string;
    endDate?: string;
    rangeLabel?: string;
    timezone?: string;
    filters?: unknown[];
    page?: string;
  };
}

const owned = (userId: string, organizationId: string, siteId: number, id: string) =>
  and(
    eq(aiConversations.id, id),
    eq(aiConversations.userId, userId),
    eq(aiConversations.organizationId, organizationId),
    eq(aiConversations.siteId, siteId)
  );

export async function findConversation(userId: string, organizationId: string, siteId: number, id: string) {
  const [row] = await db
    .select({ id: aiConversations.id, title: aiConversations.title })
    .from(aiConversations)
    .where(owned(userId, organizationId, siteId, id))
    .limit(1);
  return row;
}

export async function listConversations(userId: string, organizationId: string, siteId: number) {
  // ponytail: newest 50 threads; add cursor pagination when a Site needs more.
  return db
    .select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt })
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.userId, userId),
        eq(aiConversations.organizationId, organizationId),
        eq(aiConversations.siteId, siteId)
      )
    )
    .orderBy(desc(aiConversations.updatedAt))
    .limit(50);
}

export async function createConversation(input: {
  userId: string;
  organizationId: string;
  siteId: number;
  title: string;
}) {
  const [row] = await db
    .insert(aiConversations)
    .values({ ...input, title: input.title.slice(0, 120) })
    .returning({ id: aiConversations.id, title: aiConversations.title });
  return row;
}

export async function touchConversation(id: string) {
  await db.update(aiConversations).set({ updatedAt: new Date().toISOString() }).where(eq(aiConversations.id, id));
}

export async function renameConversation(id: string, title: string) {
  const [row] = await db
    .update(aiConversations)
    .set({ title: title.slice(0, 120), updatedAt: new Date().toISOString() })
    .where(eq(aiConversations.id, id))
    .returning({ id: aiConversations.id, title: aiConversations.title });
  return row;
}

export async function deleteConversation(id: string) {
  await db.delete(aiConversations).where(eq(aiConversations.id, id));
}

export async function appendMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  parts: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(aiMessages)
    .values({ ...input, parts: input.parts as Record<string, unknown> })
    .returning({ id: aiMessages.id, role: aiMessages.role, content: aiMessages.content, parts: aiMessages.parts });
  await touchConversation(input.conversationId);
  return row;
}

/** The last user turn, used to rebuild history for the next model call. */
export async function recentMessages(conversationId: string, limit = 20) {
  // ponytail: the tail is enough for a follow-up; summarize older turns when
  // conversations routinely exceed it.
  return db
    .select({ role: aiMessages.role, content: aiMessages.content, parts: aiMessages.parts })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(limit);
}

export async function allMessages(conversationId: string) {
  return db
    .select({
      id: aiMessages.id,
      role: aiMessages.role,
      content: aiMessages.content,
      parts: aiMessages.parts,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(aiMessages.createdAt);
}

/** Removes the trailing assistant turn so a retry can replace it. */
export async function dropLastAssistantMessage(conversationId: string) {
  const rows = await db
    .select({ id: aiMessages.id, role: aiMessages.role })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(2);
  const assistant = rows.find(row => row.role === "assistant");
  if (assistant) await db.delete(aiMessages).where(eq(aiMessages.id, assistant.id));
}

export async function recordRun(input: {
  conversationId: string;
  messageId?: string;
  model: string;
  status: "completed" | "stopped" | "error";
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  steps: number;
  error?: string;
}) {
  await db.insert(aiRuns).values({ ...input, error: input.error?.slice(0, 500) });
}

export async function listMemories(organizationId: string, siteId: number) {
  return db
    .select({ id: aiMemories.id, content: aiMemories.content, createdAt: aiMemories.createdAt })
    .from(aiMemories)
    .where(and(eq(aiMemories.organizationId, organizationId), eq(aiMemories.siteId, siteId)))
    .orderBy(desc(aiMemories.createdAt))
    .limit(50);
}

export async function addMemory(input: {
  organizationId: string;
  siteId: number;
  content: string;
  createdBy?: string;
}) {
  const [row] = await db.insert(aiMemories).values(input).returning({ id: aiMemories.id });
  return row;
}

export async function deleteMemory(id: string) {
  await db.delete(aiMemories).where(eq(aiMemories.id, id));
}

export async function setFeedback(messageId: string, rating: number, comment?: string) {
  await db
    .insert(aiFeedback)
    .values({ messageId, rating, comment: comment?.slice(0, 1000) })
    .onConflictDoUpdate({ target: aiFeedback.messageId, set: { rating, comment: comment?.slice(0, 1000) } });
}
